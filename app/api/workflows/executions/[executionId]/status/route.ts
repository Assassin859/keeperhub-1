import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTimer } from "@/lib/metrics";
import { recordStatusPollMetrics } from "@/lib/metrics/instrumentation/api";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { getWorkflowAccess } from "@/lib/workflow/access";

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

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: authContext.status,
      });
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { userId, organizationId } = authContext;

    if (!userId && !organizationId) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 403,
      });
      return NextResponse.json(
        { error: "API key has no associated user or organization. Please recreate the API key." },
        { status: 403 }
      );
    }

    // Get the execution and verify ownership
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      with: {
        workflow: true,
      },
    });

    if (!execution) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 404,
      });
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }

    // Verify access: owner or org member
    const access = await getWorkflowAccess(execution.workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    if (!access.hasFullAccess) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 404,
      });
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }

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
