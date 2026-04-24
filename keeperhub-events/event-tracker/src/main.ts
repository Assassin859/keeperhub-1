import { ENABLE_INPROC_LISTENERS } from "../lib/config/environment";
import { syncModule } from "../lib/sync/redis";
import type { ChildProcessMap, NetworksMap, RawWorkflow } from "../lib/types";
import { fetchActiveWorkflows } from "../lib/utils/fetch-utils";
import { logger } from "../lib/utils/logger";
import { createRegistry } from "./listener/factory";
import type { ListenerRegistry } from "./listener/registry";
import { buildRegistration } from "./listener/workflow-mapper";
import {
  handleActiveWorkflows,
  removeExcessProcesses,
} from "./process/manager";

const childProcesses: ChildProcessMap = {};

// Lazy: creating the registry opens a Redis connection for dedup, which we
// should not do unless the in-process path is actually in use.
let registry: ListenerRegistry | null = null;

function getRegistry(): ListenerRegistry {
  if (!registry) {
    registry = createRegistry();
  }
  return registry;
}

/**
 * Stops every listener in the registry if one was constructed. No-op when
 * the registry was never touched (fork-mode pods, or in-proc pods that
 * received a signal before the first reconcile). Kept separate from
 * `getRegistry` so shutdown does not lazily construct a registry just to
 * tear it down - that would open a Redis connection for no reason.
 */
async function shutdownRegistry(): Promise<void> {
  if (registry) {
    await registry.stopAll();
  }
}

async function reconcileForked(
  workflows: RawWorkflow[],
  networks: NetworksMap,
): Promise<void> {
  await removeExcessProcesses({
    workflows,
    childProcesses,
    syncService: syncModule,
    logger,
  });

  await handleActiveWorkflows({
    workflows,
    childProcesses,
    networks: { networks },
    syncService: syncModule,
    logger,
  });
}

async function reconcileInproc(
  workflows: RawWorkflow[],
  networks: NetworksMap,
): Promise<void> {
  const reg = getRegistry();

  const activeIds = new Set<string>(
    workflows
      .map((w) => w.id)
      .filter((id): id is string => typeof id === "string"),
  );

  // Remove listeners for workflows that are no longer active.
  for (const id of reg.ids()) {
    if (!activeIds.has(id)) {
      logger.log(`[Reconciler] removing listener ${id} (no longer active)`);
      reg.remove(id);
    }
  }

  // Add listeners for active workflows that are not yet registered, and
  // restart listeners whose config has changed since last reconcile.
  for (const workflow of workflows) {
    const registration = buildRegistration(workflow, networks);
    if (!registration) {
      continue;
    }
    const existingHash = reg.getConfigHash(registration.workflowId);
    if (existingHash === registration.configHash) {
      // Listener already running with the same config; nothing to do.
      continue;
    }
    if (existingHash !== undefined) {
      logger.log(
        `[Reconciler] config changed for ${registration.workflowId}; restarting listener`,
      );
      reg.remove(registration.workflowId);
    }
    await reg.add(registration);
  }
}

async function synchronizeData(): Promise<void> {
  logger.log("Synchronizing data");
  try {
    const result = await fetchActiveWorkflows();
    if (!result) {
      logger.warn("No data received from worker, skipping sync cycle");
      return;
    }
    const { workflows, networks } = result;

    logger.log(`Found ${workflows.length} workflows`);
    logger.log(`Found ${Object.keys(networks).length} networks`);
    if (!Array.isArray(workflows)) {
      throw new Error(
        "Invalid data received from database. Expected an array.",
      );
    }

    if (ENABLE_INPROC_LISTENERS) {
      await reconcileInproc(workflows, networks);
    } else {
      await reconcileForked(workflows, networks);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error during synchronization: ${message}`);
  }
}

export { getRegistry, shutdownRegistry, synchronizeData };
