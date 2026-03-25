import os from "node:os";
import { syncModule } from "../lib/sync/redis";
import { logger } from "../lib/utils/logger";
import { synchronizeData } from "./main";

logger.log(`Initializing container: ${os.hostname()}`);

const initialize = async (): Promise<void> => {
  try {
    await syncModule.removeAllContainers();
    logger.log("Cleared stale Redis state from previous deploys");

    await syncModule.registerContainer();
    await synchronizeData();

    setInterval(synchronizeData, 30_000);

    logger.log("Initialization complete.");
  } catch (error: any) {
    logger.error(`Error during initialization: ${error.message}`);
  }
};

initialize();
