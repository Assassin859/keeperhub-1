import { CronExpressionParser } from "cron-parser";
import { eq } from "drizzle-orm";
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

  await db
    .update(workflowExecutions)
    .set(updateData)
    .where(eq(workflowExecutions.id, executionId));
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
 * strictly greater than `now`. Mirrors lib/schedule-service.ts so the
 * executor's lastRunAt-update path stays consistent with the dispatcher.
 */
export function computeNextIntervalRunTime(
  intervalSeconds: number,
  anchorAt: Date,
  now: Date = new Date()
): Date {
  const intervalMs = intervalSeconds * 1000;
  const anchorMs = anchorAt.getTime();
  const nowMs = now.getTime();
  if (nowMs < anchorMs) {
    return new Date(anchorMs);
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

  const nextRunAt =
    schedule.intervalSeconds && schedule.anchorAt
      ? computeNextIntervalRunTime(schedule.intervalSeconds, schedule.anchorAt)
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
