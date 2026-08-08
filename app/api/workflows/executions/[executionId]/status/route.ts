import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";
import { isErrorStatus } from "@/lib/errors/execution-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTimer } from "@/lib/metrics";
import { recordStatusPollMetrics } from "@/lib/metrics/instrumentation/api";
import { HttpStatus } from "@/lib/http-status";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import {
  type AuthorizedExecution,
  type ExecutionStatusPayload,
  redactExecutionStatusForPublicView,
  resolveExecutionViewAccess,
} from "@/lib/workflow/execution-access";
import { checkExecutionStatusIpRateLimit } from "@/lib/workflow/execution-status-rate-limit";

type NodeStatus = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
};

function buildStatusPayload(
  execution: AuthorizedExecution,
  nodeStatuses: NodeStatus[]
): ExecutionStatusPayload {
  const runningCount = nodeStatuses.filter((n) => n.status === "running").length;
  const totalSteps = Number.parseInt(execution.totalSteps || "0", 10);
  const completedSteps = Number.parseInt(execution.completedSteps || "0", 10);

  return {
    status: execution.status,
    nodeStatuses,
    progress: {
      totalSteps,
      completedSteps,
      runningSteps: runningCount,
      currentNodeId: execution.currentNodeId,
      currentNodeName: execution.currentNodeName,
      percentage:
        totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
    },
    errorContext: isErrorStatus(execution.status)
      ? {
          failedNodeId: execution.currentNodeId,
          lastSuccessfulNodeId: execution.lastSuccessfulNodeId,
          lastSuccessfulNodeName: execution.lastSuccessfulNodeName,
          executionTrace: execution.executionTrace,
          error: execution.error,
        }
      : null,
    transactionHashes: execution.transactionHashes,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  const timer = createTimer();

  try {
    const { executionId } = await context.params;

    const ipRateLimit = await checkExecutionStatusIpRateLimit(request);
    if (!ipRateLimit.allowed) {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
      });
      const response = NextResponse.json(
        { error: "Too many requests" },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      );
      return applyRateLimitHeaders(response, ipRateLimit);
    }

    const viewAccess = await resolveExecutionViewAccess(request, executionId);
    if (viewAccess.mode === "invalidAuth") {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 401,
      });
      return NextResponse.json({ error: viewAccess.error }, { status: 401 });
    }
    if (viewAccess.mode === "notFound") {
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
    if (viewAccess.mode === "accessDenied") {
      recordStatusPollMetrics({
        executionId,
        durationMs: timer(),
        statusCode: 403,
      });
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const { execution } = viewAccess;

    const logs = await db.query.workflowExecutionLogs.findMany({
      where: eq(workflowExecutionLogs.executionId, executionId),
    });

    const nodeStatuses: NodeStatus[] = logs.map((log) => ({
      nodeId: log.nodeId,
      status: log.status,
    }));

    let payload = buildStatusPayload(execution, nodeStatuses);
    if (viewAccess.mode === "publicReadOnly") {
      payload = redactExecutionStatusForPublicView(payload);
    }

    recordStatusPollMetrics({
      executionId,
      durationMs: timer(),
      statusCode: 200,
      executionStatus: execution.status,
    });

    return NextResponse.json(payload);
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
