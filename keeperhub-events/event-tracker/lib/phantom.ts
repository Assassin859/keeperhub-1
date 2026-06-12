/**
 * Phantom execution helpers (KEEP-693).
 *
 * Before enqueuing an event trigger, the listener pre-creates a 'phantom'
 * workflow_executions row via the internal API so the run is visible even if it
 * never reaches the executor. The executor upgrades that row to 'pending' on
 * dequeue. If the enqueue itself fails, the listener resolves the phantom to a
 * coded failure so it surfaces in the run logs.
 *
 * Both calls are best-effort and must never block or fail a real trigger: a
 * failed create degrades to the legacy id-less enqueue (the executor inserts
 * its own row), and a failed mark is swallowed (the reaper ages it out).
 */

import { KEEPERHUB_API_KEY, KEEPERHUB_API_URL } from "./config/environment";
import { logger } from "./utils/logger";

/** Failure codes the event tracker assigns when an enqueue fails. */
export type EventErrorCode = "ES-0001" | "N-0002";

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Internal-Token": KEEPERHUB_API_KEY,
    "X-Service-Key": KEEPERHUB_API_KEY,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pre-create a phantom execution row. Returns its id, or undefined when the
 * call fails (the caller then enqueues without an id and the executor inserts
 * its own row).
 */
export async function createPhantomExecution(
  workflowId: string,
  userId: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${KEEPERHUB_API_URL}/api/internal/executions`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          workflowId,
          userId,
          status: "phantom",
          triggerSource: "event",
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as { executionId: string };
    return data.executionId;
  } catch (error) {
    logger.warn(
      `[Phantom] Failed to pre-create execution for ${workflowId}: ${formatError(error)}`,
    );
    return undefined;
  }
}

/**
 * Resolve a phantom row to a coded failure after an enqueue error. Swallows its
 * own errors -- the reaper is the backstop for an unmarked phantom.
 */
export async function failPhantomExecution(
  executionId: string,
  errorCode: EventErrorCode,
  errorMessage: string,
): Promise<void> {
  try {
    const response = await fetch(
      `${KEEPERHUB_API_URL}/api/internal/executions/${executionId}`,
      {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({
          status: "error",
          error: errorMessage,
          errorCode,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    logger.warn(
      `[Phantom] Failed to mark execution ${executionId} as failed: ${formatError(error)}`,
    );
  }
}
