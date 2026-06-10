import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users, workflowHistory, workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { buildCursorPage, parseCursorRequest } from "@/lib/pagination";
import { isOrgAdmin } from "@/lib/security/org-role";
import { getWorkflowAccess } from "@/lib/workflow/access";

/**
 * Version timeline for a workflow. Admin/owner only (history is an audit
 * trail), scoped to the workflow's org. Returns the lightweight per-version
 * metadata + diff (`change`) for the timeline; the heavy snapshot is fetched
 * on demand via GET /api/workflows/[id]?version=N. `changedBy` is enriched
 * with the actor's name/email so the UI can show "who".
 */
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
    if (
      !(access.hasFullAccess && userId && workflow.organizationId) ||
      !(await isOrgAdmin(userId, workflow.organizationId))
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const req = parseCursorRequest(url);
    const cursorVersion = Number.parseInt(req.cursor ?? "", 10);

    const conditions = [eq(workflowHistory.workflowId, workflowId)];
    if (!Number.isNaN(cursorVersion)) {
      conditions.push(
        req.direction === "next"
          ? lt(workflowHistory.version, cursorVersion)
          : gt(workflowHistory.version, cursorVersion)
      );
    }

    const rows = await db
      .select({
        version: workflowHistory.version,
        source: workflowHistory.source,
        contentHash: workflowHistory.contentHash,
        previousVersion: workflowHistory.previousVersion,
        change: workflowHistory.change,
        changedByUserId: workflowHistory.changedByUserId,
        createdAt: workflowHistory.createdAt,
      })
      .from(workflowHistory)
      .where(and(...conditions))
      .orderBy(
        req.direction === "next"
          ? desc(workflowHistory.version)
          : asc(workflowHistory.version)
      )
      .limit(req.limit + 1);

    const { items: page, _links } = buildCursorPage(
      rows,
      req,
      url,
      (r) => r.version
    );

    // Enrich actor ids -> name/email in one lookup so the timeline shows "who".
    const actorIds = [
      ...new Set(page.map((r) => r.changedByUserId).filter(Boolean)),
    ] as string[];
    const actors = actorIds.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, actorIds))
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    const items = page.map((r) => ({
      version: r.version,
      source: r.source,
      contentHash: r.contentHash,
      previousVersion: r.previousVersion,
      change: r.change,
      createdAt: r.createdAt.toISOString(),
      changedBy: r.changedByUserId
        ? (actorMap.get(r.changedByUserId) ?? { id: r.changedByUserId })
        : null,
    }));

    return NextResponse.json({ items, _links });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to read workflow history",
      error,
      { endpoint: "/api/workflows/[workflowId]/history" }
    );
    return NextResponse.json(
      { error: "Failed to read workflow history" },
      { status: 500 }
    );
  }
}
