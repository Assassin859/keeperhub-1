import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  runWorkflowSimulation,
  type WorkflowSimulationNode,
  type WorkflowSimulationResult,
} from "@/lib/workflow/run-simulation";

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  const { workflowId } = await context.params;

  const authContext = await getDualAuthContext(request, { required: true });
  if ("error" in authContext) {
    return NextResponse.json(
      { ok: false, error: authContext.error },
      { status: authContext.status }
    );
  }

  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const row = rows[0];

  const access = await getWorkflowAccess(row, {
    userId: authContext.userId,
    organizationId: authContext.organizationId,
    authMethod: authContext.authMethod,
  });

  if (access.isDeleted) {
    return NextResponse.json({ ok: false, error: "GONE" }, { status: 410 });
  }

  if (!access.hasFullAccess) {
    return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
  }

  const result = await runWorkflowSimulation({
    organizationId: row.organizationId,
    nodes: (row.nodes ?? []) as WorkflowSimulationNode[],
  });

  return NextResponse.json({
    ok: true,
    result: formatResult(result),
  });
}

/**
 * Keep the route response compact: empty issue arrays are omitted rather than
 * returned as empty arrays.
 */
function formatResult(
  result: WorkflowSimulationResult
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    simulatedNodeCount: result.simulatedNodeCount,
    skippedNodeCount: result.skippedNodeCount,
  };

  if (result.errors.length > 0) {
    out.errors = result.errors;
  }

  if (result.warnings.length > 0) {
    out.warnings = result.warnings;
  }

  return out;
}
