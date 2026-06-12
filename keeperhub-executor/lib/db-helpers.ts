import { CronExpressionParser } from "cron-parser";
import { and, eq, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  workflowExecutions,
  workflowSchedules,
  type workflows,
} from "../../lib/db/schema";
import { toJsonSafe } from "./serialize";

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
  await db
    .update(workflowExecutions)
    .set(updateData)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        ne(workflowExecutions.status, "success"),
        ne(workflowExecutions.status, "error"),
        ne(workflowExecutions.status, "cancelled")
      )
    );
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
  input: Record<string, unknown>
): Promise<boolean> {
  const result = await db
    .update(workflowExecutions)
    .set({ status: "pending", input })
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
 * KEEP-693: delete a pre-created phantom row when the executor intentionally
 * skips the trigger (workflow not found / not executable / schedule invalid).
 * The trigger correctly did not run, so there is no failure to surface and the
 * reaper must not later age the orphan to a system P-code. The compare-and-set
 * on status='phantom' makes it a no-op when there is no id or the row already
 * advanced past phantom (e.g. a duplicate delivery upgraded it).
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
        eq(workflowExecutions.status, "phantom")
      )
    );
}

/**
 * KEEP-693: resolve a pre-created phantom row to a user-actionable error (e.g. a
 * billing block) rather than leaving it for the reaper to mis-code as a system
 * failure. Compare-and-set on status='phantom' so a row that already advanced
 * is left untouched.
 */
export async function resolvePhantomToError(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string | undefined,
  fields: { error: string; errorCategory: "billing"; errorType: "user" }
): Promise<void> {
  if (!executionId) {
    return;
  }
  await db
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
        eq(workflowExecutions.status, "phantom")
      )
    );
}

export async function initializeExecutionProgress(
  db: PostgresJsDatabase<DbSchema>,
  executionId: string,
  totalSteps: number
): Promise<void> {
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
