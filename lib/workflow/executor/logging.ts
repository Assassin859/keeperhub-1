/**
 * Server-only workflow logging functions
 * These replace the HTTP endpoint for better security
 */
import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

const TERMINAL_STATUSES = new Set(["cancelled"]);

/**
 * Check if an execution has been cancelled (or otherwise terminated).
 * Used as a guard to prevent stale writes from the runtime after cancellation.
 */
async function isExecutionTerminal(executionId: string): Promise<boolean> {
  const execution = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    columns: { status: true },
  });
  return !execution || TERMINAL_STATUSES.has(execution.status);
}

export type LogStepStartParams = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  input?: unknown;
  iterationIndex?: number;
  forEachNodeId?: string;
};

export type LogStepStartResult = {
  logId: string;
  startTime: number;
};

/**
 * Log the start of a step execution
 */
export async function logStepStartDb(
  params: LogStepStartParams
): Promise<LogStepStartResult> {
  // Guard: skip if execution was cancelled (runtime continues after cancel)
  if (await isExecutionTerminal(params.executionId)) {
    return { logId: "", startTime: Date.now() };
  }

  const [log] = await db
    .insert(workflowExecutionLogs)
    .values({
      executionId: params.executionId,
      nodeId: params.nodeId,
      nodeName: params.nodeName,
      nodeType: params.nodeType,
      status: "running",
      input: params.input,
      startedAt: new Date(),
      iterationIndex: params.iterationIndex ?? null,
      forEachNodeId: params.forEachNodeId ?? null,
    })
    .returning();

  return {
    logId: log.id,
    startTime: Date.now(),
  };
}

export type LogStepCompleteParams = {
  logId: string;
  startTime: number;
  status: "success" | "error";
  output?: unknown;
  outputRaw?: unknown;
  error?: string;
  executionId?: string;
};

/**
 * Log the completion of a step execution.
 *
 * Writes two output columns:
 *   `output`     -- redacted via redactSensitiveData(), for observability/UI display.
 *   `output_raw` -- unredacted executor payload; authoritative source-of-truth for
 *                   cross-process resume so downstream templates receive real values
 *                   rather than "[REDACTED]" strings.
 */
export async function logStepCompleteDb(
  params: LogStepCompleteParams
): Promise<void> {
  // Guard: skip if execution was cancelled (runtime continues after cancel)
  if (params.executionId && (await isExecutionTerminal(params.executionId))) {
    return;
  }

  const duration = Date.now() - params.startTime;

  await db
    .update(workflowExecutionLogs)
    .set({
      status: params.status,
      output: params.output,
      outputRaw: params.outputRaw,
      error: params.error,
      completedAt: new Date(),
      duration: duration.toString(),
    })
    .where(eq(workflowExecutionLogs.id, params.logId));
}

export type LogWorkflowCompleteParams = {
  executionId: string;
  status: "success" | "error";
  output?: unknown;
  error?: string;
  startTime: number;
};

const STEP_INCOMPLETE_ERROR = "Step did not record completion";

/**
 * Close any step log rows still in 'running' for the given execution.
 * Used when the workflow reaches a terminal state to prevent orphaned
 * 'running' rows from showing as stuck spinners in the UI.
 */
async function closeOrphanedRunningLogs(
  executionId: string,
  finalStatus: "success" | "error"
): Promise<void> {
  const now = new Date();
  await db
    .update(workflowExecutionLogs)
    .set({
      status: finalStatus,
      completedAt: now,
      // Only attach an error message when closing as error
      error: finalStatus === "error" ? STEP_INCOMPLETE_ERROR : undefined,
    })
    .where(
      and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflowExecutionLogs.status, "running")
      )
    );
}

/**
 * Log the completion of a workflow execution
 */
export async function logWorkflowCompleteDb(
  params: LogWorkflowCompleteParams
): Promise<void> {
  const duration = Date.now() - params.startTime;

  // KEEP-1549: Reconcile spurious SDK errors.
  // The Workflow DevKit can throw "exceeded max retries" AFTER all steps
  // succeed. If we're about to write status='error', check whether any
  // node log actually failed. If none did, the error is spurious.
  //
  // KEEP-333: 'running' logs mean a step was started but never recorded
  // completion (e.g. the worker was killed mid-step). That is not a
  // spurious SDK error - the workflow really is incomplete. Keep 'error'
  // and close the orphaned rows below so the UI doesn't show stuck
  // spinners.
  //
  // KEEP-431: Aggregate by nodeId rather than counting raw rows. Under
  // cross-pod SDK checkpoint resume, a step that already succeeded on pod A
  // can be re-fired on pod B, leaving an orphan 'running' or 'error' row
  // from the interrupted retry while the original success row is intact.
  // Treat a node as succeeded if it has at least one success row -- only
  // flag the workflow as failed when a node has no success row at all.
  // This is the difference between "step really is incomplete" (no success
  // row anywhere) and "framework retry was interrupted after the body
  // already recorded success" (success row exists, orphan running/error
  // row from the retry). Critical for x402/call_workflow paid callers who
  // hit large fan-in workflows where the cross-pod resume is the norm.
  let resolvedStatus: "success" | "error" = params.status;
  let resolvedError: string | undefined = params.error;

  if (params.status === "error") {
    // Route through unified logger so org/owner ALS context is attached.
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Logging] Execution completed with error, checking node logs for reconciliation",
      params.error ?? "unknown",
      { execution_id: params.executionId }
    );

    try {
      const allLogs = await db.query.workflowExecutionLogs.findMany({
        where: eq(workflowExecutionLogs.executionId, params.executionId),
        columns: { nodeId: true, status: true },
      });

      // Per-nodeId aggregate: a node "succeeded" if any of its rows is success.
      const nodeSucceeded = new Map<string, boolean>();
      for (const log of allLogs) {
        if (log.status === "success") {
          nodeSucceeded.set(log.nodeId, true);
        } else if (!nodeSucceeded.has(log.nodeId)) {
          nodeSucceeded.set(log.nodeId, false);
        }
      }

      const trulyFailedNodes: string[] = [];
      for (const [nodeId, succeeded] of nodeSucceeded) {
        if (!succeeded) {
          trulyFailedNodes.push(nodeId);
        }
      }

      if (trulyFailedNodes.length === 0) {
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[Workflow Logging] No node-level errors found, overriding spurious SDK error to success",
          params.error ?? "unknown",
          { execution_id: params.executionId }
        );
        resolvedStatus = "success";
        resolvedError = undefined;
      }
      // Confirmed-error path is not itself an error event - skip logging.
    } catch (queryError) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Logging] Failed to query node logs for reconciliation, keeping original error status",
        queryError,
        { execution_id: params.executionId }
      );
    }
  }

  // Close orphaned 'running' logs before updating the execution so that
  // any concurrent reader sees a consistent snapshot.
  try {
    await closeOrphanedRunningLogs(params.executionId, resolvedStatus);
  } catch (closeError) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Logging] Failed to close orphaned running logs",
      closeError,
      { execution_id: params.executionId }
    );
  }

  await db
    .update(workflowExecutions)
    .set({
      status: resolvedStatus,
      output: params.output,
      error: resolvedError,
      completedAt: new Date(),
      duration: duration.toString(),
      // Clear current step on completion
      currentNodeId: null,
      currentNodeName: null,
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        ne(workflowExecutions.status, "cancelled")
      )
    );
}

// ============================================================================
// Progress Tracking Functions
// ============================================================================

export type InitializeProgressParams = {
  executionId: string;
  totalSteps: number;
};

/**
 * Initialize progress tracking at the start of workflow execution.
 * Sets total step count and resets progress counters.
 */
export async function initializeProgress(
  params: InitializeProgressParams
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      totalSteps: params.totalSteps.toString(),
      completedSteps: "0",
      executionTrace: [],
      currentNodeId: null,
      currentNodeName: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    })
    .where(eq(workflowExecutions.id, params.executionId));
}

export type UpdateCurrentStepParams = {
  executionId: string;
  currentNodeId: string;
  currentNodeName: string;
};

/**
 * Update the currently executing step.
 * Called when a step starts execution.
 */
export async function updateCurrentStep(
  params: UpdateCurrentStepParams
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      currentNodeId: params.currentNodeId,
      currentNodeName: params.currentNodeName,
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        ne(workflowExecutions.status, "cancelled")
      )
    );
}

export type IncrementCompletedStepsParams = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  success: boolean;
};

/**
 * Increment the completed steps counter and append to the execution trace.
 * Called when a step completes (success or error).
 *
 * Uses a single atomic UPDATE so concurrent fan-out steps (for-each, parallel
 * branches) cannot overwrite each other's trace entries or counter increments.
 * The WHERE clause replaces the pre-read terminal-status guard, eliminating
 * the TOCTOU race against cancellation.
 *
 * Returns void; the UPDATE silently affects 0 rows when the execution is
 * cancelled (or has been deleted). Callers should not depend on the trace
 * being incremented for late-arriving step completions on cancelled runs.
 */
export async function incrementCompletedSteps(
  params: IncrementCompletedStepsParams
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      completedSteps: sql`(COALESCE(${workflowExecutions.completedSteps}, '0')::int + 1)::text`,
      executionTrace: sql`COALESCE(${workflowExecutions.executionTrace}, '[]'::jsonb) || ${JSON.stringify([params.nodeId])}::jsonb`,
      currentNodeId: null,
      currentNodeName: null,
      ...(params.success
        ? {
            lastSuccessfulNodeId: params.nodeId,
            lastSuccessfulNodeName: params.nodeName,
          }
        : {}),
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        ne(workflowExecutions.status, "cancelled")
      )
    );
}
