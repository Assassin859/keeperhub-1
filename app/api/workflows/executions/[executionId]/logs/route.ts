import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { redactSensitiveData } from "@/lib/utils/redact";
import { getWorkflowAccess } from "@/lib/workflow/access";

type TruncatedMarker = {
  _truncated: true;
  originalSize: number;
  preview: string;
};

function truncateField(value: unknown, maxBytes: number): unknown | TruncatedMarker {
  if (value === null || value === undefined) {
    return value;
  }
  const stringified = JSON.stringify(value);
  if (stringified === undefined) {
    return value;
  }
  const originalSize = Buffer.byteLength(stringified, "utf8");
  if (originalSize <= maxBytes) {
    return value;
  }
  return {
    _truncated: true as const,
    originalSize,
    preview: stringified.slice(0, maxBytes),
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await context.params;

    const { searchParams } = new URL(request.url);
    const includeDataRaw = searchParams.get("includeData");
    const includeData =
      includeDataRaw === null ? undefined : includeDataRaw !== "false";
    const nodeIdsParam = searchParams.getAll("nodeIds");
    const nodeIds = nodeIdsParam.length > 0 ? nodeIdsParam : undefined;
    const truncateDataRaw = searchParams.get("truncateData");
    const truncateDataParsed =
      truncateDataRaw === null ? Number.NaN : Number.parseInt(truncateDataRaw, 10);
    const truncateData =
      Number.isFinite(truncateDataParsed) && truncateDataParsed > 0
        ? truncateDataParsed
        : undefined;
    const hasAnyPartialParam =
      includeData !== undefined ||
      nodeIds !== undefined ||
      truncateData !== undefined;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { userId, organizationId } = authContext;

    if (!userId && !organizationId) {
      return NextResponse.json(
        { error: "API key has no associated user or organization. Please recreate the API key." },
        { status: 403 }
      );
    }

    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      with: {
        workflow: true,
      },
    });

    if (!execution) {
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(execution.workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    if (!access.hasFullAccess) {
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }

    const logs = await db.query.workflowExecutionLogs.findMany({
      where: eq(workflowExecutionLogs.executionId, executionId),
      orderBy: [desc(workflowExecutionLogs.timestamp)],
    });

    const redactedLogs = logs.map((log) => ({
      ...log,
      input: redactSensitiveData(log.input),
      output: redactSensitiveData(log.output),
    }));

    if (!hasAnyPartialParam) {
      return NextResponse.json({
        execution,
        logs: redactedLogs,
      });
    }

    const nodeIdSet = nodeIds ? new Set(nodeIds) : null;
    const transformedLogs = redactedLogs.map((log) => {
      const stripData = includeData === false;
      const stripForNodeFilter =
        !stripData && nodeIdSet !== null && !nodeIdSet.has(log.nodeId);
      if (stripData || stripForNodeFilter) {
        // biome-ignore lint/correctness/noUnusedVariables: destructure-to-omit pattern
        const { input: _input, output: _output, outputRaw: _outputRaw, ...rest } = log;
        return rest;
      }
      if (truncateData !== undefined) {
        return {
          ...log,
          input: truncateField(log.input, truncateData),
          output: truncateField(log.output, truncateData),
          outputRaw: truncateField(log.outputRaw, truncateData),
        };
      }
      return log;
    });

    return NextResponse.json({
      execution,
      logs: transformedLogs,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get execution logs", error, {
      endpoint: "/api/workflows/executions/logs",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get execution logs",
      },
      { status: 500 }
    );
  }
}
