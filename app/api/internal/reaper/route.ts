import { and, eq, gt, inArray, lt, notInArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

const DEFAULT_THRESHOLD_MINUTES = 30;

function getThresholdMinutes(): number {
  const envValue = process.env.STALE_EXECUTION_THRESHOLD_MINUTES;
  if (!envValue) {
    return DEFAULT_THRESHOLD_MINUTES;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isNaN(parsed) ? DEFAULT_THRESHOLD_MINUTES : parsed;
}

/**
 * GET /api/internal/reaper
 *
 * Finds workflow executions stuck in "running" state with no recent activity
 * and marks them as "error" with a timeout message.
 *
 * Intended to be called by an external cron job (K8s CronJob).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const thresholdMinutes = getThresholdMinutes();
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

    // Find execution IDs that have recent step activity (should NOT be reaped)
    const activeExecutionIds = await db
      .select({
        executionId: workflowExecutionLogs.executionId,
      })
      .from(workflowExecutionLogs)
      .where(gt(workflowExecutionLogs.completedAt, cutoff))
      .groupBy(workflowExecutionLogs.executionId);

    const excludeIds = activeExecutionIds.map((row) => row.executionId);

    // Bulk update all stale executions in a single query, excluding those with recent activity
    const staleConditions = and(
      eq(workflowExecutions.status, "running"),
      lt(workflowExecutions.startedAt, cutoff),
      excludeIds.length > 0
        ? notInArray(workflowExecutions.id, excludeIds)
        : undefined
    );

    const reaped = await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: `Execution timed out: no activity for ${thresholdMinutes} minutes`,
        completedAt: new Date(),
        duration: sql`ROUND(EXTRACT(EPOCH FROM (NOW() - ${workflowExecutions.startedAt})) * 1000)`,
      })
      .where(staleConditions)
      .returning({ id: workflowExecutions.id });

    const reapedIds = reaped.map((row) => row.id);

    // KEEP-333: Close orphaned 'running' step logs for reaped executions so
    // the UI doesn't show stuck spinners after the workflow has been marked
    // as timed out.
    if (reapedIds.length > 0) {
      await db
        .update(workflowExecutionLogs)
        .set({
          status: "error",
          error: "Step did not record completion",
          completedAt: new Date(),
        })
        .where(
          and(
            inArray(workflowExecutionLogs.executionId, reapedIds),
            eq(workflowExecutionLogs.status, "running")
          )
        );
    }

    return NextResponse.json({
      reapedCount: reapedIds.length,
      reapedIds,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to reap stale executions",
      error,
      { endpoint: "/api/internal/reaper", operation: "get" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reap stale executions",
      },
      { status: 500 }
    );
  }
}
