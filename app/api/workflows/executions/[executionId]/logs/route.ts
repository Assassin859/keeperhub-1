import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { redactSensitiveData } from "@/lib/utils/redact";
import { getWorkflowAccess } from "@/lib/workflow/access";

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await context.params;

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

    // Get the execution and verify ownership
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

    // Verify access: owner or org member
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

    // Get logs
    const logs = await db.query.workflowExecutionLogs.findMany({
      where: eq(workflowExecutionLogs.executionId, executionId),
      orderBy: [desc(workflowExecutionLogs.timestamp)],
    });

    // Apply an additional layer of redaction to ensure no sensitive data is exposed
    // Even though data should already be redacted when stored, this provides defense in depth
    const redactedLogs = logs.map((log) => ({
      ...log,
      input: redactSensitiveData(log.input),
      output: redactSensitiveData(log.output),
    }));

    return NextResponse.json({
      execution,
      logs: redactedLogs,
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
