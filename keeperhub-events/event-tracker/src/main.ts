import { syncModule } from "../lib/sync/redis";
import type { ChildProcessMap } from "../lib/types";
import { fetchActiveWorkflows } from "../lib/utils/fetch-utils";
import { logger } from "../lib/utils/logger";
import {
  handleActiveWorkflows,
  removeExcessProcesses,
} from "./process/manager";

const childProcesses: ChildProcessMap = {};

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
  } catch (error: any) {
    logger.error(`Error during synchronization: ${error.message}`);
  }
}

export { synchronizeData };
