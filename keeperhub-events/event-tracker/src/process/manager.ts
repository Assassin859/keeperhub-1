import { WorkflowEvent } from "../../lib/models/workflow-event";
import type { SyncModule } from "../../lib/sync/redis";
import type {
  ChildProcessMap,
  NetworksWrapper,
  ProcessEntry,
} from "../../lib/types";
import type { Logger } from "../../lib/utils/logger";
import { WorkflowHandler } from "./workflow-handler";

async function removeExcessProcesses({
  workflows,
  childProcesses,
  syncService,
  logger,
}: {
  workflows: any[];
  childProcesses: ChildProcessMap;
  syncService: SyncModule;
  logger: Logger;
}): Promise<void> {
  const activeKeys = Object.keys(childProcesses);
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));

  logger.log(
    `Checking for excess processes: ${activeKeys.length} running processes, ${workflows.length} active workflows`,
  );

  const excessProcessIds = activeKeys.filter(
    (processId) => !workflowIds.has(processId),
  );

  if (excessProcessIds.length === 0) {
    logger.log("No excess processes to remove");
    return;
  }

  logger.log(
    `Found ${
      excessProcessIds.length
    } excess process(es) to remove: ${excessProcessIds.join(", ")}`,
  );

  await Promise.all(
    excessProcessIds.map(async (excessProcessId) => {
      try {
        logger.log(
          `REMOVING EXCESS PROCESS: [ ${excessProcessId} ] - This workflow is no longer an active workflow`,
        );
        const excessProcess = childProcesses[excessProcessId];

        if (!excessProcess) {
          logger.warn(
            `Process [ ${excessProcessId} ] not found in childProcesses, removing from Redis only`,
          );
          await syncService.removeProcess(excessProcessId);
          return;
        }

        if (excessProcess?.process) {
          if (excessProcess.process.killed) {
            logger.log(
              `Process [ ${excessProcessId} ] already killed, cleaning up Redis keys`,
            );
          } else {
            logger.log(
              `KILLING PROCESS: [ ${excessProcessId} ] - Process PID: ${excessProcess.process.pid}`,
            );
            await excessProcess.handler.killWorkflow({
              shouldRestart: false,
            });
            logger.log(`Process [ ${excessProcessId} ] killed successfully`);
          }
        } else {
          logger.warn(
            `Process [ ${excessProcessId} ] has no process object, removing from Redis only`,
          );
        }

        await syncService.removeProcess(excessProcessId);

        delete childProcesses[excessProcessId];

        logger.log(
          `PROCESS REMOVED: [ ${excessProcessId} ] - Successfully cleaned up from Redis and local tracking`,
        );
      } catch (error: any) {
        logger.warn(
          `Failed to remove process [${excessProcessId}]: ${error.message}`,
        );
        delete childProcesses[excessProcessId];
      }
    }),
  );
}

async function checkWorkflowStatus(
  workflowId: string,
  syncService: SyncModule,
): Promise<{ runningElsewhere: boolean; runningOnThisContainer: boolean }> {
  const runningElsewhere =
    (await syncService.isWorkflowAlreadyRunningInAnotherContainer(
      workflowId,
    )) ?? false;
  const isWorkflowRunningOnThisContainer =
    (await syncService.isWorkflowRunningOnThisContainer(workflowId)) ?? false;

  return {
    runningElsewhere,
    runningOnThisContainer: isWorkflowRunningOnThisContainer,
  };
}

function createWorkflowHandler(
  event: any,
  networks: NetworksWrapper,
  logger: Logger,
  syncService: SyncModule,
): WorkflowHandler {
  const workflowEvent = new WorkflowEvent(event);
  return new WorkflowHandler({
    event: workflowEvent,
    logger,
    syncService,
    index: event.id,
    networks,
    rawEventData: event,
  });
}

function shouldRestartExistingProcess(
  existingProcess: ProcessEntry,
  event: any,
  runningElsewhere: boolean,
): boolean {
  if (runningElsewhere) {
    return false;
  }
  return !!existingProcess.handler.event.hasConfigurationChanged(event);
}

async function restartExistingProcess(
  existingProcess: ProcessEntry,
  workflowEvent: WorkflowEvent,
  event: any,
  logger: Logger,
): Promise<ProcessEntry> {
  logger.log(
    `Process [ ${existingProcess.process?.pid} ] has different configuration. Restarting KeeperEvent: ${event.name} - ${event.id}`,
  );

  const restartedHandler =
    await existingProcess.handler.restartWorkflowWithAnotherEvent(
      workflowEvent,
      event,
    );

  return restartedHandler.currentProcess;
}

async function handleExistingProcess({
  existingProcess,
  event,
  workflowEvent,
  runningElsewhere,
  runningOnThisContainer,
  logger,
}: {
  existingProcess: ProcessEntry;
  event: any;
  workflowEvent: WorkflowEvent;
  runningElsewhere: boolean;
  runningOnThisContainer: boolean;
  logger: Logger;
}): Promise<{ handled: boolean; newProcess?: ProcessEntry }> {
  if (runningElsewhere) {
    logger.log(`Workflow ${event.id} is already running in another container`);
    return { handled: true };
  }

  const configurationChanged = shouldRestartExistingProcess(
    existingProcess,
    event,
    runningElsewhere,
  );

  if (configurationChanged) {
    const newProcess = await restartExistingProcess(
      existingProcess,
      workflowEvent,
      event,
      logger,
    );
    return { handled: true, newProcess };
  }

  if (!existingProcess.process?.killed && runningOnThisContainer) {
    const contractAddress =
      event.nodes?.[0]?.data?.config?.contractAddress || "?";
    const formattedAddress = logger.formatAddress
      ? logger.formatAddress(contractAddress)
      : contractAddress;
    logger.log(
      `PROCESS ACTIVE: [ ${existingProcess.process?.pid} ] is already active and up-to-date. WorkflowEvent: ${event.name} - ${event.id} - Contract: ${formattedAddress}`,
    );
    return { handled: true };
  }

  return { handled: false };
}

async function startNewProcess(
  workflowHandler: WorkflowHandler,
  event: any,
  logger: Logger,
): Promise<ProcessEntry> {
  logger.log(
    `Starting or restarting child process for WorkflowEvent: ${event.name} - ${event.id}`,
  );

  await workflowHandler.startProcess();
  return workflowHandler.currentProcess;
}

async function handleWorkflowEvent({
  event,
  childProcesses,
  networks,
  syncService,
  logger,
}: {
  event: any;
  childProcesses: ChildProcessMap;
  networks: NetworksWrapper;
  syncService: SyncModule;
  logger: Logger;
}): Promise<ProcessEntry | undefined> {
  const { runningElsewhere, runningOnThisContainer } =
    await checkWorkflowStatus(event.id, syncService);

  if (runningElsewhere) {
    return;
  }

  const existingProcess = childProcesses[event.id];
  const workflowEvent = new WorkflowEvent(event);
  const workflowHandler = createWorkflowHandler(
    event,
    networks,
    logger,
    syncService,
  );

  if (existingProcess) {
    const result = await handleExistingProcess({
      existingProcess,
      event,
      workflowEvent,
      runningElsewhere,
      runningOnThisContainer,
      logger,
    });

    if (result.handled) {
      if (result.newProcess) {
        return result.newProcess;
      }
      return;
    }
  }

  return await startNewProcess(workflowHandler, event, logger);
}

async function handleActiveWorkflows({
  workflows,
  childProcesses,
  networks,
  syncService,
  logger,
}: {
  workflows: any[];
  childProcesses: ChildProcessMap;
  networks: NetworksWrapper;
  syncService: SyncModule;
  logger: Logger;
}): Promise<void> {
  for (const event of workflows) {
    try {
      const newProcess = await handleWorkflowEvent({
        event,
        childProcesses,
        networks,
        syncService,
        logger,
      });

      if (newProcess) {
        childProcesses[event.id] = newProcess;
      }
    } catch (error: any) {
      logger.warn(error);
      logger.warn(
        `Issue handling active workflow [${event.id}]: ${error.message}`,
      );
    }
  }
}

export { removeExcessProcesses, handleActiveWorkflows };
