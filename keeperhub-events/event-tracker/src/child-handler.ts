import { WorkflowEvent } from "../lib/models/workflow-event";
import type { NetworksWrapper } from "../lib/types";
import { logger } from "../lib/utils/logger";
import {
  getIsShuttingDown,
  setShuttingDown,
} from "../lib/utils/shutdown-state";
import { EventHandlerFactory } from "./chains/event-handler-factory";

let blockchainEventHandler: any = null;

interface EventMessage {
  event: any;
  networks: any;
}

async function handleEventMessage(message: EventMessage): Promise<void> {
  let workflowEvent: WorkflowEvent | undefined;
  try {
    if (message.event) {
      workflowEvent = new WorkflowEvent(message.event);
    } else if (message instanceof WorkflowEvent) {
      workflowEvent = message;
    } else {
      workflowEvent = new WorkflowEvent(message as any);
    }

    const networksData = message.networks || {};
    const networks: NetworksWrapper = networksData.networks
      ? networksData
      : { networks: networksData };

    blockchainEventHandler = new EventHandlerFactory(
      workflowEvent,
      logger,
      networks,
    ).buildChainHandler();

    if (process.pid) {
      logger.log(
        `Starting event listener ~ process: ${
          process.pid
        } - address: ${logger.formatAddress(
          workflowEvent.contractAddress!,
        )} - chain: ${workflowEvent.chain} - event: ${
          workflowEvent.eventName
        } - workflow: ${workflowEvent.name} - id: ${workflowEvent.id}`,
      );
    }

    await blockchainEventHandler.listenEvent();
    process?.send?.({
      status: "listening",
      chain: workflowEvent.chain,
      pid: process.pid,
    });

    const memoryUsage = process.memoryUsage();

    logger.log(
      `Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
    );
  } catch (error: any) {
    logger.warn(error);
    const eventInfo = workflowEvent
      ? `chain ${workflowEvent.chain} and WorkflowEvent: ${JSON.stringify(
          workflowEvent.name,
        )}:${workflowEvent.id}`
      : "unknown event";
    logger.warn(
      `Child process issue for ${eventInfo}\nDetails: ${error.message}`,
    );
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  setShuttingDown();
  logger.log(
    `[Shutdown] Received ${signal}, starting graceful shutdown... (isShuttingDown=${getIsShuttingDown()})`,
  );

  if (
    blockchainEventHandler &&
    typeof blockchainEventHandler.destroy === "function"
  ) {
    try {
      await blockchainEventHandler.destroy();
      logger.log("[Shutdown] Blockchain event handler destroyed successfully");
    } catch (error: any) {
      logger.warn(
        `[Shutdown] Issue destroying event handler: ${error.message}`,
      );
    }
  }

  logger.log("[Shutdown] Graceful shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("disconnect", () => gracefulShutdown("disconnect"));
process.on("message", handleEventMessage);
