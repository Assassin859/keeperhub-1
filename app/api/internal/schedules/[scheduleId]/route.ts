import { CronExpressionParser } from "cron-parser";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowSchedules } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";

type RouteContext = {
  params: Promise<{ scheduleId: string }>;
};

function computeNextRunTime(
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

// KEEP-575: interval-schedule next-fire = first anchor + k*interval > now,
// k >= 1. First fire is anchor + 1*interval (never the anchor itself).
function computeNextIntervalRunTime(
  intervalSeconds: number,
  anchorAt: Date,
  now: Date = new Date()
): Date {
  const intervalMs = intervalSeconds * 1000;
  const anchorMs = anchorAt.getTime();
  const nowMs = now.getTime();
  const firstFireMs = anchorMs + intervalMs;
  if (nowMs < firstFireMs) {
    return new Date(firstFireMs);
  }
  const elapsedMs = nowMs - anchorMs;
  const kNext = Math.floor(elapsedMs / intervalMs) + 1;
  return new Date(anchorMs + kNext * intervalMs);
}

export async function GET(request: Request, context: RouteContext) {
  const auth = authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401 }
    );
  }

  const { scheduleId } = await context.params;

  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }

  return NextResponse.json({ schedule });
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401 }
    );
  }

  const { scheduleId } = await context.params;

  const body = await request.json();
  const { status, error } = body as { status?: string; error?: string };

  if (status !== "success" && status !== "error") {
    return NextResponse.json(
      { error: "Invalid status. Must be 'success' or 'error'" },
      { status: 400 }
    );
  }

  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }

  // KEEP-575: strict null/undefined checks so a stray zero in either
  // column can't silently fall through to the cron path.
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

  return NextResponse.json({ success: true });
}
