import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTimer } from "@/lib/metrics";
import { recordStatusPollMetrics } from "@/lib/metrics/instrumentation/api";
import { resolveAuthorizedExecution } from "@/lib/workflow/execution-access";

type NodeStatus = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
};

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  const timer = createTimer();

  try {
    const { executionId } = await context.params;

    const resolved = await resolveAuthorizedExecution(request, executionId);
    if (!resolved.ok) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: resolved.status,
      });
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }
    const { execution } = resolved;

    // Get logs for all nodes
    const logs = await db.query.workflowExecutionLogs.findMany({
      where: eq(workflowExecutionLogs.executionId, executionId),
    });

    // Map logs to node statuses
    const nodeStatuses: NodeStatus[] = logs.map((log) => ({
      nodeId: log.nodeId,
      status: log.status,
    }));

    // Calculate running count for parallel execution visibility
    const runningCount = nodeStatuses.filter(
      (n) => n.status === "running"
    ).length;
    const totalSteps = Number.parseInt(execution.totalSteps || "0", 10);
    const completedSteps = Number.parseInt(execution.completedSteps || "0", 10);

    // Build progress data
    const progress = {
      totalSteps,
      completedSteps,
      runningSteps: runningCount,
      currentNodeId: execution.currentNodeId,
      currentNodeName: execution.currentNodeName,
      percentage:
        totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
    };

    // Build error context (only when failed)
    const errorContext =
      execution.status === "error"
        ? {
            failedNodeId: execution.currentNodeId,
            lastSuccessfulNodeId: execution.lastSuccessfulNodeId,
            lastSuccessfulNodeName: execution.lastSuccessfulNodeName,
            executionTrace: execution.executionTrace,
            error: execution.error,
          }
        : null;

    recordStatusPollMetrics({
      executionId,
      durationMs: timer(),
      statusCode: 200,
      executionStatus: execution.status,
    });

    return NextResponse.json({
      status: execution.status,
      nodeStatuses,
      progress,
      errorContext,
      transactionHashes: execution.transactionHashes,
    });
  } catch (error) {
    const { executionId } = await context.params;
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get execution status",
      error,
      {
        endpoint: "/api/workflows/executions/[executionId]/status",
        operation: "get",
      }
    );
    recordStatusPollMetrics({
      executionId,
      durationMs: timer(),
      statusCode: 500,
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get execution status",
      },
      { status: 500 }
    );
  }
}
