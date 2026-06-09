/**
 * Schedule Dispatcher Script
 *
 * Runs continuously and evaluates workflow schedules every minute.
 * Dispatches matching cron expressions to SQS for execution.
 *
 * Usage:
 *   pnpm dispatcher
 *
 * Environment variables:
 *   KEEPERHUB_API_URL - KeeperHub API URL (default: http://localhost:3000)
 *   KEEPERHUB_API_KEY - Service API key for authentication
 *   AWS_ENDPOINT_URL - LocalStack endpoint (default: http://localhost:4566)
 *   SQS_QUEUE_URL - SQS queue URL (default: LocalStack queue)
 *   HEALTH_PORT - Health check server port (default: 3060)
 */

import express from "express";
import { KEEPERHUB_URL, SQS_QUEUE_URL } from "../lib/config.js";
import { dispatch } from "./dispatch.js";

// Log and swallow detached promise rejections so transient failures do not
// crash the dispatcher (Node v15+ exits on unhandled rejection by default).
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : "";
  console.error(`[Dispatcher] Unhandled rejection: ${message}`, stack);
});

// Uncaught sync exceptions indicate corrupted state; log and exit so the
// orchestrator restarts us cleanly rather than continuing in an unknown state.
process.on("uncaughtException", (error: Error) => {
  console.error(
    `[Dispatcher] Uncaught exception: ${error.message}`,
    error.stack ?? "",
  );
  process.exit(1);
});

async function main(): Promise<void> {
  if (!process.env.INTERNAL_SERVICE_HMAC_SECRET) {
    throw new Error("INTERNAL_SERVICE_HMAC_SECRET is required");
  }
  console.log("[Dispatcher] Starting schedule dispatcher...");
  console.log(`[Dispatcher] KeeperHub URL: ${KEEPERHUB_URL}`);
  console.log(`[Dispatcher] SQS Queue URL: ${SQS_QUEUE_URL}`);

  const healthApp = express();
  const HEALTH_PORT = process.env.HEALTH_PORT || 3060;

  healthApp.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "schedule-dispatcher",
      timestamp: new Date().toISOString(),
    });
  });

  const healthServer = healthApp.listen(HEALTH_PORT, () => {
    console.log(
      `[Dispatcher] Health check server listening on port ${HEALTH_PORT}`,
    );
  });

  const shutdownHandler = (): void => {
    console.log("\n[Dispatcher] Shutting down...");
    healthServer.close(() => {
      console.log("[Dispatcher] Health server closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGHUP", shutdownHandler);
  process.on("SIGUSR1", () => {
    console.warn(
      "[Security] SIGUSR1 received; inspector activation suppressed",
    );
  });

  console.log("[Dispatcher] Running initial dispatch...");
  try {
    await dispatch();
  } catch (error) {
    console.error("[Dispatcher] Initial dispatch failed:", error);
  }

  console.log("[Dispatcher] Starting interval (runs every 60 seconds)");
  setInterval(async () => {
    try {
      await dispatch();
    } catch (error) {
      console.error("[Dispatcher] Dispatch failed:", error);
    }
  }, 60_000);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Dispatcher] Fatal startup error: ${message}`);
  process.exit(1);
});
