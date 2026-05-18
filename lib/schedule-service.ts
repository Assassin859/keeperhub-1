import { CronExpressionParser } from "cron-parser";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowSchedules } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { generateId } from "@/lib/utils/id";
import type { WorkflowNode } from "@/lib/workflow/store";

// Top-level regex for splitting cron expression fields
const CRON_FIELD_SPLITTER = /\s+/;

/**
 * Compute the next run time for a cron expression in a given timezone
 */
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
  } catch (error) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      `[Schedule] Invalid cron expression: ${cronExpression}`,
      error,
      {
        component: "schedule-service",
        cron_expression: cronExpression,
      }
    );
    return null;
  }
}

/**
 * Compute the next run time for an interval schedule (KEEP-575).
 *
 * Fires on `anchor + k * intervalSeconds`. Returns the next k >= 1 in the
 * future relative to `now`. If `now < anchor`, returns the anchor itself
 * (a schedule that hasn't started yet fires first at its anchor).
 */
export function computeNextIntervalRunTime(
  intervalSeconds: number,
  anchorAt: Date,
  now: Date = new Date()
): Date {
  const intervalMs = intervalSeconds * 1000;
  const anchorMs = anchorAt.getTime();
  const nowMs = now.getTime();
  // Strictly before the anchor: the first fire is the anchor itself.
  // At the anchor (or past it): the k=0 fire has happened, so the next
  // future fire is anchor + ceil((now - anchor + 1ms) / interval) * interval.
  if (nowMs < anchorMs) {
    return new Date(anchorMs);
  }
  const elapsedMs = nowMs - anchorMs;
  const kNext = Math.floor(elapsedMs / intervalMs) + 1;
  return new Date(anchorMs + kNext * intervalMs);
}

/**
 * Validate a cron expression
 */
export function validateCronExpression(cronExpression: string): {
  valid: boolean;
  error?: string;
} {
  if (!cronExpression || typeof cronExpression !== "string") {
    return { valid: false, error: "Cron expression is required" };
  }

  // Basic format check (5 or 6 fields)
  const parts = cronExpression.trim().split(CRON_FIELD_SPLITTER);
  if (parts.length < 5 || parts.length > 6) {
    return {
      valid: false,
      error: "Cron expression must have 5 or 6 fields",
    };
  }

  try {
    CronExpressionParser.parse(cronExpression);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid cron expression",
    };
  }
}

/**
 * Validate timezone string
 */
export function validateTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Discriminated schedule configuration extracted from a trigger node.
 *
 * KEEP-575: interval mode lets us represent "every N minutes" accurately
 * when N doesn't divide 60 — something a single 5-field cron cannot do.
 */
export type ExtractedScheduleConfig =
  | { mode: "cron"; cronExpression: string; timezone: string }
  | { mode: "interval"; intervalSeconds: number; timezone: string };

/**
 * Extract schedule configuration from workflow trigger node
 */
export function extractScheduleConfig(
  nodes: WorkflowNode[]
): ExtractedScheduleConfig | null {
  const triggerNode = nodes.find((n) => n.data.type === "trigger");

  if (!triggerNode) {
    return null;
  }

  const config = triggerNode.data.config;
  if (config?.triggerType !== "Schedule") {
    return null;
  }

  const timezone = (config.scheduleTimezone as string) || "UTC";

  const intervalSecondsRaw = config.scheduleIntervalSeconds;
  const intervalSeconds = parseIntervalSeconds(intervalSecondsRaw);
  if (intervalSeconds !== null) {
    return { mode: "interval", intervalSeconds, timezone };
  }

  const cronExpression = config.scheduleCron as string | undefined;
  if (!cronExpression) {
    return null;
  }

  return { mode: "cron", cronExpression, timezone };
}

/**
 * Coerce a `scheduleIntervalSeconds` value (number or numeric string from
 * the trigger config JSONB) into a positive integer, or null if the value
 * is missing or unusable.
 */
function parseIntervalSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return Math.floor(n);
}

/**
 * Sync workflow schedule based on trigger configuration
 * Called when a workflow is saved
 */
export async function syncWorkflowSchedule(
  workflowId: string,
  nodes: WorkflowNode[]
): Promise<{ synced: boolean; error?: string }> {
  const scheduleConfig = extractScheduleConfig(nodes);

  if (!scheduleConfig) {
    // No schedule trigger - delete any existing schedule
    await db
      .delete(workflowSchedules)
      .where(eq(workflowSchedules.workflowId, workflowId));

    console.log(`[Schedule] Removed schedule for workflow ${workflowId}`);
    return { synced: true };
  }

  const { timezone } = scheduleConfig;

  // Validate timezone (shared by both modes)
  if (!validateTimezone(timezone)) {
    console.warn(
      `[Schedule] Invalid timezone for workflow ${workflowId}: ${timezone}`
    );
    return { synced: false, error: `Invalid timezone: ${timezone}` };
  }

  // Validate the mode-specific payload up front so we never write a half-
  // valid row to the DB.
  if (scheduleConfig.mode === "cron") {
    const cronValidation = validateCronExpression(
      scheduleConfig.cronExpression
    );
    if (!cronValidation.valid) {
      console.warn(
        `[Schedule] Invalid cron for workflow ${workflowId}: ${cronValidation.error}`
      );
      return { synced: false, error: cronValidation.error };
    }
  }

  const existingSchedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.workflowId, workflowId),
  });

  if (scheduleConfig.mode === "cron") {
    const { cronExpression } = scheduleConfig;
    const nextRunAt = computeNextRunTime(cronExpression, timezone);

    if (existingSchedule) {
      await db
        .update(workflowSchedules)
        .set({
          cronExpression,
          intervalSeconds: null,
          anchorAt: null,
          timezone,
          nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(workflowSchedules.workflowId, workflowId));

      console.log(
        `[Schedule] Updated schedule for workflow ${workflowId}: ${cronExpression} (${timezone})`
      );
    } else {
      await db.insert(workflowSchedules).values({
        id: generateId(),
        workflowId,
        cronExpression,
        timezone,
        enabled: true,
        nextRunAt,
      });

      console.log(
        `[Schedule] Created schedule for workflow ${workflowId}: ${cronExpression} (${timezone})`
      );
    }

    return { synced: true };
  }

  // Interval mode (KEEP-575). The cron column is kept non-null so legacy
  // readers that parse it don't blow up — we stash a best-effort synthetic
  // value, but the dispatcher checks intervalSeconds first and ignores cron.
  const { intervalSeconds } = scheduleConfig;
  const syntheticCron = synthesizeCronForInterval(intervalSeconds);

  // Re-anchor only when the interval changes (or when switching modes).
  // Preserving the anchor across no-op autosaves keeps fire-times stable.
  const intervalChanged =
    !existingSchedule ||
    existingSchedule.intervalSeconds !== intervalSeconds ||
    !existingSchedule.anchorAt;
  const anchorAt = intervalChanged
    ? new Date()
    : (existingSchedule?.anchorAt ?? new Date());
  const nextRunAt = computeNextIntervalRunTime(intervalSeconds, anchorAt);

  if (existingSchedule) {
    await db
      .update(workflowSchedules)
      .set({
        cronExpression: syntheticCron,
        intervalSeconds,
        anchorAt,
        timezone,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(workflowSchedules.workflowId, workflowId));

    console.log(
      `[Schedule] Updated schedule for workflow ${workflowId}: every ${intervalSeconds}s (${timezone})`
    );
  } else {
    await db.insert(workflowSchedules).values({
      id: generateId(),
      workflowId,
      cronExpression: syntheticCron,
      intervalSeconds,
      anchorAt,
      timezone,
      enabled: true,
      nextRunAt,
    });

    console.log(
      `[Schedule] Created schedule for workflow ${workflowId}: every ${intervalSeconds}s (${timezone})`
    );
  }

  return { synced: true };
}

/**
 * Build a best-effort 5-field cron string for an interval, used only as a
 * fallback display value for the cron_expression column when the schedule
 * is actually in interval mode. The dispatcher never parses this — it sees
 * intervalSeconds is non-null and switches paths.
 */
function synthesizeCronForInterval(intervalSeconds: number): string {
  const minutes = Math.max(1, Math.round(intervalSeconds / 60));
  if (minutes >= 60) {
    return `0 */${Math.min(23, Math.floor(minutes / 60))} * * *`;
  }
  return `*/${minutes} * * * *`;
}

/**
 * Get schedule for a workflow
 */
export async function getWorkflowSchedule(
  workflowId: string
): Promise<typeof workflowSchedules.$inferSelect | null> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.workflowId, workflowId),
  });
  return schedule || null;
}

/**
 * Update schedule enabled status
 */
export async function setScheduleEnabled(
  workflowId: string,
  enabled: boolean
): Promise<void> {
  await db
    .update(workflowSchedules)
    .set({
      enabled,
      updatedAt: new Date(),
    })
    .where(eq(workflowSchedules.workflowId, workflowId));

  console.log(
    `[Schedule] ${enabled ? "Enabled" : "Disabled"} schedule for workflow ${workflowId}`
  );
}

/**
 * Update schedule after execution
 */
export async function updateScheduleAfterRun(
  scheduleId: string,
  status: "success" | "error",
  error?: string
): Promise<void> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    console.error(`[Schedule] Schedule not found: ${scheduleId}`);
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

  console.log(`[Schedule] Updated schedule ${scheduleId} after run: ${status}`);
}
