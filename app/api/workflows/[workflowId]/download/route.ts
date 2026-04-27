import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getOrgContext } from "@/lib/middleware/org-context";
import { buildWorkflowExportV1 } from "@/lib/workflow/export-schema";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

const FILENAME_SANITIZE_REGEX = /[^a-z0-9]+/g;
const TRIM_DASHES_REGEX = /^-+|-+$/g;

function sanitizeFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(FILENAME_SANITIZE_REGEX, "-")
    .replace(TRIM_DASHES_REGEX, "");
  return slug || "workflow";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const isOwner = session.user.id === workflow.userId;
    const orgContext = await getOrgContext();
    const isSameOrg =
      !workflow.isAnonymous &&
      workflow.organizationId &&
      orgContext.organization?.id === workflow.organizationId;

    if (!(isOwner || isSameOrg)) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const exportPayload = buildWorkflowExportV1({
      name: workflow.name,
      description: workflow.description,
      nodes: workflow.nodes as WorkflowNode[],
      edges: workflow.edges as WorkflowEdge[],
    });

    const fileName = `${sanitizeFileName(workflow.name)}.workflow.json`;

    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to export workflow",
      error,
      {
        endpoint: "/api/workflows/[workflowId]/download",
        operation: "get",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to export workflow",
      },
      { status: 500 }
    );
  }
}
