import { CronExpressionParser } from "cron-parser";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  workflowExecutions,
  workflowSchedules,
  type workflows,
} from "../../lib/db/schema";
import type { ErrorCode } from "../../lib/errors/error-codes";
import { calculateTotalSteps } from "../../lib/workflow/executor/progress";
import type { WorkflowEdge, WorkflowNode } from "../../lib/workflow/store";
import type { executeWorkflow } from "../../lib/workflow/executor/executor.workflow";
import { toJsonSafe } from "./serialize";
import { recordTerminalSample } from "./terminal-counters";

export type DbSchema = {
  workflows: typeof workflows;
  workflowExecutions: typeof workflowExecutions;
  workflowSchedules: typeof workflowSchedules;
};

export async function updateExecutionStatus(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  status: "running" | "success" | "error" | "cancelled",
  result?: { output?: unknown; error?: string }
): Promise<void> {
  const updateData: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };

  if (status === "success" || status === "error") {
    updateData.completedAt = new Date();
  }
  if (result?.output !== undefined) {
    updateData.output = toJsonSafe(result.output);
  }
  if (result?.error) {
    updateData.error = result.error;
  }

  // Only transition a row that has not already reached a terminal state. The
  // workflow engine (logWorkflowCompleteDb, via triggerStep _workflowComplete)
  // is the authoritative writer of the final status - including its
  // error->success reconciliation - and runs from inside executeWorkflow. The
  // runner/in-process callers re-issue success/error through here as a
  // backstop: if the engine's own write landed, the row is already
  // success/error/cancelled and this update is a no-op; if that write was lost
  // (it can throw and only be logged), this closes the row instead of leaving
  // it stuck "running". Excluding all three terminal states keeps the backstop
  // from clobbering the engine's richer fields (KEEP-431).
  const updated = await db
    .update(workflowExecutions)
    .set(updateData)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        ne(workflowExecutions.status, "success"),
        ne(workflowExecutions.status, "error"),
        ne(workflowExecutions.status, "system_error"),
        ne(workflowExecutions.status, "cancelled")
      )
    )
    .returning({ workflowId: workflowExecutions.workflowId });

  // A matched row means the engine's own terminal write was lost (the CAS
  // above excludes every terminal state), so this backstop is the execution's
  // first and only terminal transition and must emit the terminal counters
  // the engine would have emitted. Cancellation is intentionally not counted
  // (the finished counter tracks success/error outcomes only).
  if (
    updated.length > 0 &&
    (status === "success" || status === "error")
  ) {
    await recordTerminalSample(db, {
      workflowId: updated[0].workflowId,
      status,
      errorMessage: result?.error,
    });
  }
}

/**
 * KEEP-853: backstop for the SQS consumer. When message processing throws for a
 * reason the inner dispatch handlers did not already record, mark the in-flight
 * row as a system error right away instead of leaving it for the reaper (which
 * runs minutes later). Compare-and-set on status IN ('phantom','pending') so it
 * never clobbers a row the runtime already advanced to running/terminal.
 *
 * Returns true when a row was marked, false when the CAS matched nothing (no
 * executionId, or the row already advanced past phantom/pending). The caller
 * surfaces the false case instead of treating the backstop as resolved, since
 * such a row is left for the reaper rather than marked immediately.
 */
export async function failExecutionAsSystemError(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string | undefined,
  fields: { error: string; errorCode: ErrorCode }
): Promise<boolean> {
  if (!executionId) {
    return false;
  }
  const marked = await db
    .update(workflowExecutions)
    .set({
      status: "system_error",
      error: fields.error,
      errorCode: fields.errorCode,
      errorType: "system",
      errorCategory: "infrastructure",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        inArray(workflowExecutions.status, ["phantom", "pending"])
      )
    )
    .returning({
      id: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
    });

  // The phantom/pending CAS means a match is the row's first terminal
  // transition; these rows never reach logWorkflowCompleteDb or the reaper,
  // so this is their only chance to be counted.
  if (marked.length > 0) {
    await recordTerminalSample(db, {
      workflowId: marked[0].workflowId,
      status: "system_error",
      errorMessage: fields.error,
      errorType: "system",
      errorCategory: "infrastructure",
    });
  }
  return marked.length > 0;
}

/**
 * KEEP-693: upgrade a pre-created 'phantom' execution row to 'pending' in place
 * and stamp its input.
 *
 * The scheduler/event-tracker pre-creates a 'phantom' row and passes its id on
 * the SQS message; the executor calls this to claim it. The compare-and-set on
 * status='phantom' makes the claim idempotent: a duplicate SQS delivery (or a
 * missing phantom, when the best-effort create failed, or one already advanced
 * past phantom) matches no row and returns false, so the caller falls back to a
 * fresh insert and a run is never dropped.
 */
export async function upgradePhantomToPending(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  input: Record<string, unknown>,
  executedWorkflowHash: string
): Promise<boolean> {
  const result = await db
    .update(workflowExecutions)
    // KEEP-693: the phantom was created billable=false (it had not run yet);
    // upgrading to pending means it is now a real execution, so it becomes
    // billable like any owner-initiated run. Stamp the hash of the definition
    // the executor just loaded so the run links to its workflow_history version.
    .set({ status: "pending", input, billable: true, executedWorkflowHash })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.status, "phantom")
      )
    )
    .returning({ id: workflowExecutions.id });
  return result.length > 0;
}

/**
 * KEEP-693: delete a pre-created phantom or pending row when the executor
 * intentionally skips the trigger (workflow not found / not executable /
 * schedule invalid). The trigger correctly did not run, so there is no failure
 * to surface and the reaper must not later age the orphan to a system P-code.
 * The compare-and-set on status IN ('phantom', 'pending') makes it a no-op
 * when there is no id or the row already advanced past these states.
 *
 * Matches 'pending' in addition to 'phantom' because manual-trigger executions
 * are pre-created by the API as 'pending' before being enqueued.
 */
export async function discardPhantomRow(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string | undefined
): Promise<void> {
  if (!executionId) {
    return;
  }
  await db
    .delete(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        inArray(workflowExecutions.status, ["phantom", "pending"])
      )
    );
}

/**
 * KEEP-693: resolve a pre-created phantom or pending row to a user-actionable
 * error (e.g. a billing block) rather than leaving it for the reaper to
 * mis-code as a system failure. Compare-and-set on status IN ('phantom',
 * 'pending') so a row that already advanced is left untouched.
 *
 * Matches 'pending' in addition to 'phantom' because manual-trigger executions
 * are pre-created by the API as 'pending' (not 'phantom') before being enqueued.
 */
export async function resolvePhantomToError(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string | undefined,
  fields: { error: string; errorCategory: "billing"; errorType: "user" }
): Promise<void> {
  if (!executionId) {
    return;
  }
  const resolved = await db
    .update(workflowExecutions)
    .set({
      status: "error",
      error: fields.error,
      errorCategory: fields.errorCategory,
      errorType: fields.errorType,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        inArray(workflowExecutions.status, ["phantom", "pending"])
      )
    )
    .returning({ workflowId: workflowExecutions.workflowId });

  // Same reasoning as failExecutionAsSystemError: the phantom/pending CAS
  // makes a match the first terminal transition, and billing-blocked rows
  // never reach any other counted finalize path.
  if (resolved.length > 0) {
    await recordTerminalSample(db, {
      workflowId: resolved[0].workflowId,
      status: "error",
      errorMessage: fields.error,
      errorType: fields.errorType,
      errorCategory: fields.errorCategory,
    });
  }
}

export async function initializeExecutionProgress(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): Promise<void> {
  const totalSteps = calculateTotalSteps(nodes, edges);
  await db
    .update(workflowExecutions)
    .set({
      totalSteps: totalSteps.toString(),
      completedSteps: "0",
      executionTrace: [],
      currentNodeId: null,
      currentNodeName: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    })
    .where(eq(workflowExecutions.id, executionId));
}

type ExecuteWorkflowResult = Awaited<ReturnType<typeof executeWorkflow>>;

/**
 * Write the terminal execution status (success or error) and optionally update
 * the associated schedule row. Replaces the identical if/else block that
 * workflow-runner.ts and in-process.ts both maintained after executeWorkflow().
 *
 * Returns the error message string on failure (null on success) so callers can
 * use it for their own logging without re-deriving it.
 */
export async function applyExecutionResult(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  result: ExecuteWorkflowResult,
  opts: { scheduleId?: string }
): Promise<{ errorMessage: string | null }> {
  if (result.success) {
    await updateExecutionStatus(db, executionId, "success", {
      output: result.outputs,
    });
    if (opts.scheduleId) {
      await updateScheduleStatus(db, opts.scheduleId, "success");
    }
    return { errorMessage: null };
  }

  const errorMessage =
    result.error ||
    Object.values(result.results || {}).find((r) => !r.success)?.error ||
    "Unknown error";

  await updateExecutionStatus(db, executionId, "error", {
    error: errorMessage,
    output: result.outputs,
  });
  if (opts.scheduleId) {
    await updateScheduleStatus(db, opts.scheduleId, "error", errorMessage);
  }
  return { errorMessage };
}

export function computeNextRunTime(
  cronExpression: string,
  timezone: string
): Date | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(),
      tz: timezone,
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * KEEP-575: next interval fire time = first `anchor + k * intervalSeconds`
 * with k >= 1 and the value strictly greater than `now`. First fire is
 * `anchor + 1 * interval` (not the anchor itself). Mirrors
 * lib/schedule-service.ts so the executor's lastRunAt-update path stays
 * consistent with the dispatcher.
 */
export function computeNextIntervalRunTime(
  intervalSeconds: number,
  anchorAt: Date,
  now: Date = new Date()
): Date {
  // KEEP-575: throw on garbage inputs rather than silently writing
  // Invalid Date to workflow_schedules.next_run_at. Mirrors the
  // lib/schedule-service.ts guard so the executor and the app stay
  // consistent.
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error(
      `computeNextIntervalRunTime: invalid intervalSeconds ${String(intervalSeconds)}`
    );
  }
  const anchorMs = anchorAt.getTime();
  if (!Number.isFinite(anchorMs)) {
    throw new Error(
      "computeNextIntervalRunTime: invalid anchorAt (getTime returned NaN)"
    );
  }
  const intervalMs = intervalSeconds * 1000;
  const nowMs = now.getTime();
  const firstFireMs = anchorMs + intervalMs;
  if (nowMs < firstFireMs) {
    return new Date(firstFireMs);
  }
  const elapsedMs = nowMs - anchorMs;
  const kNext = Math.floor(elapsedMs / intervalMs) + 1;
  return new Date(anchorMs + kNext * intervalMs);
}

export async function updateScheduleStatus(
  db: PostgresJsDatabase<DbSchema>,
  scheduleId: string,
  status: "success" | "error",
  error?: string
): Promise<void> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    return;
  }

  // KEEP-575: strict !== checks so a stray zero/null in either column
  // can't silently demote the row to the cron path.
  const intervalSeconds = schedule.intervalSeconds;
  const anchorAt = schedule.anchorAt;
  const isInterval =
    intervalSeconds !== null &&
    intervalSeconds > 0 &&
    anchorAt !== null &&
    anchorAt !== undefined;
  const nextRunAt = isInterval
    ? computeNextIntervalRunTime(intervalSeconds, anchorAt)
    : computeNextRunTime(schedule.cronExpression, schedule.timezone);

  const runCount =
    status === "success"
      ? String(Number(schedule.runCount || "0") + 1)
      : schedule.runCount;

  await db
    .update(workflowSchedules)
    .set({
      lastRunAt: new Date(),
      lastStatus: status,
      lastError: status === "error" ? error : null,
      nextRunAt,
      runCount,
      updatedAt: new Date(),
    })
    .where(eq(workflowSchedules.id, scheduleId));
}
