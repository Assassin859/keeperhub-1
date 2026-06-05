import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTimer } from "@/lib/metrics";
import { recordStatusPollMetrics } from "@/lib/metrics/instrumentation/api";
import {
  DEFAULT_CALL_WAIT_TIMEOUT_MS,
  waitForExecutionCompletion,
} from "@/lib/payments/x402/execution-wait";
import { resolveAuthorizedExecution } from "@/lib/workflow/execution-access";

// Cap how long a single request blocks so it stays under typical HTTP/MCP
// client timeouts and never pins a serverless worker indefinitely. Clients
// re-call to keep waiting past this window.
const MAX_WAIT_TIMEOUT_MS = 60_000;

function parseTimeoutMs(request: Request): number {
  const raw = new URL(request.url).searchParams.get("timeoutMs");
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CALL_WAIT_TIMEOUT_MS;
  }
  return Math.min(Math.max(parsed, 0), MAX_WAIT_TIMEOUT_MS);
}

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

    const timeoutMs = parseTimeoutMs(request);
    const result = await waitForExecutionCompletion(executionId, timeoutMs);

    // Re-read the row after waiting: the poller only resolves status/output/
    // error, but the receipt needs transactionHashes/gas/completedAt too.
    const fresh = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      columns: {
        status: true,
        output: true,
        error: true,
        transactionHashes: true,
        gasUsedWei: true,
        completedAt: true,
      },
    });

    if (!fresh) {
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

    recordStatusPollMetrics({
      executionId,
      durationMs: timer(),
      statusCode: 200,
      executionStatus: fresh.status,
    });

    // result is null on timeout (still pending/running); non-null once the
    // execution reached a terminal state within the wait window.
    return NextResponse.json({
      executionId,
      status: fresh.status,
      completed: result !== null,
      transactionHashes: fresh.transactionHashes ?? [],
      output: fresh.output,
      error: fresh.error ?? null,
      gasUsedWei: fresh.gasUsedWei,
      completedAt: fresh.completedAt,
    });
  } catch (error) {
    const { executionId } = await context.params;
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to wait for execution receipt",
      error,
      {
        endpoint: "/api/workflows/executions/[executionId]/wait",
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
            : "Failed to wait for execution receipt",
      },
      { status: 500 }
    );
  }
}
