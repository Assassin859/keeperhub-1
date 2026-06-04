import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users, workflowHistory, workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { isOrgAdmin } from "@/lib/security/org-role";
import { getWorkflowAccess } from "@/lib/workflow/access";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

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
    const limit = parseLimit(url.searchParams.get("limit"));
    const beforeVersion = Number.parseInt(
      url.searchParams.get("before") ?? "",
      10
    );

    const conditions = [eq(workflowHistory.workflowId, workflowId)];
    if (!Number.isNaN(beforeVersion)) {
      conditions.push(lt(workflowHistory.version, beforeVersion));
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
      .orderBy(desc(workflowHistory.version))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

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

    const versions = page.map((r) => ({
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

    return NextResponse.json({
      versions,
      nextCursor: hasMore ? page.at(-1)?.version : null,
    });
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
