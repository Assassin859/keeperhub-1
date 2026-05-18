import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { getWorkflowAccess } from "@/lib/workflow/access";

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { userId, organizationId } = authContext;

    // Verify workflow access (owner or org member)
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: execution history is hidden once the workflow is soft-deleted.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Fetch executions
    const executions = await db.query.workflowExecutions.findMany({
      where: eq(workflowExecutions.workflowId, workflowId),
      orderBy: [desc(workflowExecutions.startedAt)],
      limit: 50,
    });

    return NextResponse.json(executions);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get executions", error, {
      endpoint: "/api/workflows/[workflowId]/executions",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get executions",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }
    const { userId, organizationId } = authContext;

    // Verify workflow access (owner or org member)
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const access = await getWorkflowAccess(workflow, {
      userId,
      organizationId,
      authMethod: authContext.authMethod,
    });

    // KEEP-440: execution history is hidden once the workflow is soft-deleted.
    if (!access.hasFullAccess || access.isDeleted) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Get all execution IDs for this workflow
    const executions = await db.query.workflowExecutions.findMany({
      where: eq(workflowExecutions.workflowId, workflowId),
      columns: { id: true },
    });

    const executionIds = executions.map((e) => e.id);

    // Delete logs first (if there are any executions)
    if (executionIds.length > 0) {
      const { workflowExecutionLogs } = await import("@/lib/db/schema");
      const { inArray } = await import("drizzle-orm");

      await db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.executionId, executionIds));

      // Then delete the executions
      await db
        .delete(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, workflowId));
    }

    return NextResponse.json({
      success: true,
      deletedCount: executionIds.length,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to delete executions",
      error,
      {
        endpoint: "/api/workflows/[workflowId]/executions",
        operation: "delete",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete executions",
      },
      { status: 500 }
    );
  }
}
