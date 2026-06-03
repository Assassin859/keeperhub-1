import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import { buildAttribution } from "@/lib/security/request-attribution";

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const body = JSON.parse(rawBody);
  const { workflowId, userId, input } = body;

  if (!(workflowId && userId)) {
    return NextResponse.json(
      { error: "workflowId and userId are required" },
      { status: 400 }
    );
  }

  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
    columns: {
      organizationId: true,
      deletedAt: true,
      nodes: true,
    },
  });

  // KEEP-440: never create an execution for a soft-deleted workflow.
  if (!workflow || workflow.deletedAt) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  const featureGuard = await enforceWorkflowFeatures(
    extractActionTypeNodes(workflow.nodes as unknown[]),
    workflow.organizationId
  );
  if (featureGuard.blocked) {
    return featureGuard.response;
  }

  const executionGuard = await enforceExecutionLimit(workflow.organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  const attribution = buildAttribution({ request, source: "internal" });

  const [execution] = await withBackstopCapture(
    { workflowId, userId, source: "internal" },
    () =>
      db
        .insert(workflowExecutions)
        .values({
          workflowId,
          userId,
          status: "running",
          input: input || {},
          ...attribution,
        })
        .returning({ id: workflowExecutions.id })
  );

  return NextResponse.json({ executionId: execution.id }, { status: 201 });
}
