import os from "node:os";
import { logger } from "../lib/utils/logger";
import { chainProviderManager } from "./chains/provider-manager";
import {
  type HealthServerHandle,
  startHealthServer,
} from "./health/health-server";
import { shutdownRegistry, synchronizeData } from "./main";

const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 3001);
let healthServer: HealthServerHandle | null = null;

// Fatal-error handlers: an uncaught exception or unhandled rejection inside a
// listener callback is almost always a bug that leaves the process in an
// indeterminate state. Log and exit so K8s restarts the pod. Blast radius is
// the whole pod, which makes these handlers load-bearing.
process.on("uncaughtException", (err: Error) => {
  logger.error(`[Fatal] uncaughtException: ${err.message}\n${err.stack ?? ""}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  logger.error(`[Fatal] unhandledRejection: ${message}\n${stack}`);
  process.exit(1);
});

// Graceful shutdown: K8s sends SIGTERM on pod rotation. The pod owns every
// listener, so we must stop them here. Best-effort - if stopAll throws we
// still exit so K8s can restart.
async function shutdown(signal: string): Promise<void> {
  logger.log(`[Shutdown] received ${signal}; stopping listeners`);
  try {
    await shutdownRegistry();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Shutdown] error during registry shutdown: ${message}`);
  }
  if (healthServer) {
    try {
      await healthServer.close();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Shutdown] error closing health server: ${message}`);
    }
  }
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

logger.log(`Initializing container: ${os.hostname()}`);

const initialize = async (): Promise<void> => {
  if (!process.env.INTERNAL_SERVICE_HMAC_SECRET) {
    throw new Error("INTERNAL_SERVICE_HMAC_SECRET is required");
  }
  // Health server bind must succeed for K8s probes to work. Kept outside
  // the try/catch below so a bind failure (port taken, EACCES) rejects
  // initialize(), which the unhandledRejection handler turns into
  // exit(1) for K8s restart. A silent bind failure would zombify the
  // pod: process alive, no workflows running, no probe.
  healthServer = await startHealthServer(chainProviderManager, HEALTH_PORT);
  logger.log(`[Health] /healthz listening on :${healthServer.port}`);

  try {
    await synchronizeData();

    setInterval(synchronizeData, 30_000);

    logger.log("Initialization complete.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error during initialization: ${message}`);
  }
};

initialize();
