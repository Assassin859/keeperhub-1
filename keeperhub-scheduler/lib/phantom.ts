/**
 * Phantom execution helpers (KEEP-693).
 *
 * Before enqueuing a trigger, the dispatcher pre-creates a 'phantom'
 * workflow_executions row via the internal API so the run is visible even if
 * it never reaches the executor (dispatcher down, SQS lost). The executor
 * upgrades that row to 'pending' on dequeue. If the enqueue itself fails, the
 * dispatcher resolves the phantom to a coded failure so it surfaces in the run
 * logs instead of being aged out generically by the reaper.
 *
 * Both calls are best-effort: a failure to create a phantom degrades to the
 * legacy id-less enqueue (the executor inserts its own row), and a failure to
 * mark a phantom is swallowed (the reaper ages it out as a fallback). Neither
 * must ever block or fail a real trigger.
 */

import { apiRequest } from "./http-client.js";

/** Trigger sources the scheduler reports for phantom attribution. */
export type PhantomTriggerSource = "schedule" | "block";

/** Failure codes the scheduler assigns when an enqueue fails. */
export type SchedulerErrorCode = "CS-0001" | "BS-0001" | "N-0002";

/**
 * Pre-create a phantom execution row. Returns its id, or undefined when the
 * call fails (the caller then enqueues without an id and the executor inserts
 * its own row).
 */
export async function createPhantomExecution(
  workflowId: string,
  triggerSource: PhantomTriggerSource,
  userId?: string,
): Promise<string | undefined> {
  try {
    const result = await apiRequest<{ executionId: string }>(
      "/api/internal/executions",
      {
        method: "POST",
        body: JSON.stringify({
          workflowId,
          userId,
          status: "phantom",
          triggerSource,
        }),
      },
    );
    return result.executionId;
  } catch (error) {
    console.warn(
      `[Phantom] Failed to pre-create execution for workflow ${workflowId}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Resolve a phantom row to a coded failure after an enqueue error. Swallows
 * its own errors -- the reaper is the backstop for an unmarked phantom.
 */
export async function failPhantomExecution(
  executionId: string,
  errorCode: SchedulerErrorCode,
  errorMessage: string,
): Promise<void> {
  try {
    await apiRequest(`/api/internal/executions/${executionId}`, {
      method: "PATCH",
      body: JSON.stringify({
        // KEEP-853: an enqueue failure is a platform/infra fault, so the run
        // surfaces as a system error, distinct from user/workflow errors.
        status: "system_error",
        error: errorMessage,
        errorCode,
      }),
    });
  } catch (error) {
    console.warn(
      `[Phantom] Failed to mark execution ${executionId} as failed:`,
      error,
    );
  }
}
