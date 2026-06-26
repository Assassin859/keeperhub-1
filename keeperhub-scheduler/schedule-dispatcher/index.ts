/**
 * Schedule Dispatcher Script
 *
 * Runs continuously and evaluates workflow schedules on aligned minute
 * boundaries. Dispatches matching cron expressions to SQS for execution.
 *
 * Usage:
 *   pnpm dispatcher
 *
 * Environment variables:
 *   KEEPERHUB_API_URL - KeeperHub API URL (default: http://localhost:3000)
 *   INTERNAL_SERVICE_HMAC_SECRET - HMAC signing secret for internal service auth
 *   AWS_ENDPOINT_URL  - LocalStack endpoint (default: http://localhost:4566)
 *   SQS_QUEUE_URL     - SQS queue URL (default: LocalStack queue)
 *   HEALTH_PORT       - Health check server port (default: 3060)
 *   TICK_OFFSET_MS    - Milliseconds past the minute boundary to fire
 *                       (default: 2000). Cron occurrences land at :00;
 *                       firing at :02 guarantees they are always in the past
 *                       and still well within the 5-second SLA.
 */

// Normalize all console.* output in this process to canonical JSON. Must be
// the first import so the patch installs before any module logs.
import "../log-facade.js";
import express from "express";
import { KEEPERHUB_URL, SQS_QUEUE_URL } from "../lib/config.js";
import { dispatch } from "./dispatch.js";
import { registry } from "./metrics.js";

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

// How far past the minute boundary (:00) each tick fires. 2 s ensures cron
// occurrences (which land at :00) are always comfortably in the past without
// pushing the trigger time close to the 5-second SLA ceiling.
const TICK_OFFSET_MS = Number(process.env.TICK_OFFSET_MS ?? 2_000);

/**
 * Returns the number of milliseconds until the next tick target:
 * the start of the next wall-clock minute plus TICK_OFFSET_MS.
 *
 * Example: if now is 09:00:42.500 and TICK_OFFSET_MS=2000 the next target
 * is 09:01:02.000, so this returns ~19_500 ms.
 */
function msUntilNextTick(): number {
  const msIntoMinute = Date.now() % 60_000;
  if (msIntoMinute < TICK_OFFSET_MS) {
    // Still early in the current minute — fire at TICK_OFFSET_MS of this minute.
    return TICK_OFFSET_MS - msIntoMinute;
  }
  // Past the target for this minute — wait to the same offset in the next minute.
  return 60_000 - msIntoMinute + TICK_OFFSET_MS;
}

async function main(): Promise<void> {
  if (!process.env.INTERNAL_SERVICE_HMAC_SECRET) {
    throw new Error("INTERNAL_SERVICE_HMAC_SECRET is required");
  }
  console.log("[Dispatcher] Starting schedule dispatcher...");
  console.log(`[Dispatcher] KeeperHub URL: ${KEEPERHUB_URL}`);
  console.log(`[Dispatcher] SQS Queue URL: ${SQS_QUEUE_URL}`);
  console.log(`[Dispatcher] Tick offset: ${TICK_OFFSET_MS}ms past minute boundary`);

  const healthApp = express();
  const HEALTH_PORT = process.env.HEALTH_PORT || 3060;

  healthApp.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "schedule-dispatcher",
      timestamp: new Date().toISOString(),
    });
  });

  healthApp.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).send(`Error collecting metrics: ${message}`);
    }
  });

  const healthServer = healthApp.listen(HEALTH_PORT, () => {
    console.log(
      `[Dispatcher] Health/metrics server listening on port ${HEALTH_PORT}`,
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

  // lastTickAt tracks the `now` of the previous pass so each tick's window
  // covers exactly (lastTickAt, now] — no gaps, no double-fires. It resets
  // to null on pod restart, which makes the first pass use a synthetic
  // (now - 60s, now] window (safe: at most one occurrence can be missed).
  let lastTickAt: Date | null = null;

  // Run the initial tick immediately to catch any schedules due at boot,
  // then align subsequent ticks to the wall-clock minute boundary.
  console.log("[Dispatcher] Running initial dispatch...");
  try {
    await dispatch(lastTickAt);
  } catch (error) {
    console.error("[Dispatcher] Initial dispatch failed:", error);
  }
  // The initial dispatch does not update lastTickAt — on pod restart we want
  // the first aligned tick to use the synthetic window so it can recover any
  // occurrence that may have been missed since the last pod's final tick.

  const alignDelay = msUntilNextTick();
  console.log(
    `[Dispatcher] Aligning to minute boundary — first aligned tick in ${alignDelay}ms`,
  );

  // Self-scheduling setTimeout: after each tick recompute the delay to the
  // next minute boundary. This naturally absorbs drift from slow DB queries
  // without accumulating phase error the way a fixed setInterval would.
  const scheduleTick = async (): Promise<void> => {
    const prevTick = lastTickAt;
    lastTickAt = new Date();

    try {
      await dispatch(prevTick);
    } catch (error) {
      console.error("[Dispatcher] Dispatch failed:", error);
    }

    setTimeout(() => {
      scheduleTick().catch((error: unknown) => {
        console.error("[Dispatcher] Tick scheduling error:", error);
      });
    }, msUntilNextTick());
  };

  setTimeout(() => {
    scheduleTick().catch((error: unknown) => {
      console.error("[Dispatcher] First aligned tick error:", error);
    });
  }, alignDelay);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Dispatcher] Fatal startup error: ${message}`);
  process.exit(1);
});
