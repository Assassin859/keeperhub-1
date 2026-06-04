import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getOrgContext } from "@/lib/middleware/org-context";

// RETIRED IN PRACTICE: claiming moved an anonymous null-org workflow into the
// caller's org, but every workflow is org-owned now (anonymous sessions get an
// org at signup, account-link re-parents their content, and is_anonymous was
// normalized to false), so the gate below always rejects. The route stays only
// because the client claim dialog still references it; remove both together.
export async function POST(
  _request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    const orgContext = await getOrgContext();

    if (!orgContext.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!orgContext.organization?.id) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 400 }
      );
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

    if (!workflow.isAnonymous || workflow.userId !== orgContext.user.id) {
      return NextResponse.json(
        { error: "Cannot claim this workflow" },
        { status: 403 }
      );
    }

    // KEEP-440: a soft-deleted workflow cannot be claimed into an org.
    if (workflow.deletedAt) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(workflow.nodes as unknown[]),
      orgContext.organization.id,
      {
        errorMessage:
          "Can't claim this workflow: it uses features your current organization's plan doesn't include. Upgrade to claim it here, or remove the gated nodes first.",
      }
    );
    if (featureGuard.blocked) {
      return featureGuard.response;
    }

    const [updatedWorkflow] = await db
      .update(workflows)
      .set({
        organizationId: orgContext.organization.id,
        isAnonymous: false,
        userId: orgContext.user.id,
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, workflowId))
      .returning();

    return NextResponse.json(updatedWorkflow);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to claim workflow", error, { endpoint: "/api/workflows/[workflowId]/claim", operation: "post" });
    return NextResponse.json(
      { error: "Failed to claim workflow" },
      { status: 500 }
    );
  }
}
