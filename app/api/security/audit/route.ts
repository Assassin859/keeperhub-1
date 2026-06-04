import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";

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
 * Read the org's security audit trail. Sensitive forensic data, so it is
 * session-gated and limited to organization owners/admins; the events are
 * always scoped to the caller's active organization. Filterable by action,
 * resource, and actor, with a created_at cursor for pagination -- all of
 * which are served by the composite indexes on security_audit_log.
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgCtx = await resolveOrganizationId(request);
    if ("error" in orgCtx) {
      return NextResponse.json(
        { error: orgCtx.error },
        { status: orgCtx.status }
      );
    }
    const { organizationId } = orgCtx;

    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.userId, session.user.id),
          eq(member.organizationId, organizationId)
        )
      )
      .limit(1);

    if (
      !membership ||
      (membership.role !== "owner" && membership.role !== "admin")
    ) {
      return NextResponse.json(
        { error: "Only organization owners and admins can view the audit log" },
        { status: 403 }
      );
    }

    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const action = url.searchParams.get("action");
    const resourceType = url.searchParams.get("resourceType");
    const resourceId = url.searchParams.get("resourceId");
    const actorUserId = url.searchParams.get("actorUserId");
    const before = url.searchParams.get("before");

    const conditions = [eq(securityAuditLog.organizationId, organizationId)];
    if (action) {
      conditions.push(eq(securityAuditLog.action, action));
    }
    if (resourceType) {
      conditions.push(eq(securityAuditLog.resourceType, resourceType));
    }
    if (resourceId) {
      conditions.push(eq(securityAuditLog.resourceId, resourceId));
    }
    if (actorUserId) {
      conditions.push(eq(securityAuditLog.actorUserId, actorUserId));
    }
    if (before) {
      const beforeDate = new Date(before);
      if (!Number.isNaN(beforeDate.getTime())) {
        conditions.push(lt(securityAuditLog.createdAt, beforeDate));
      }
    }

    // Fetch one extra row to derive the next-page cursor without a count query.
    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(and(...conditions))
      .orderBy(desc(securityAuditLog.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page.at(-1)?.createdAt.toISOString() : null;

    // Enrich actor ids -> name/email so the UI can show "who did it".
    const actorIds = [
      ...new Set(page.map((r) => r.actorUserId).filter(Boolean)),
    ] as string[];
    const actors = actorIds.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, actorIds))
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    const events = page.map((r) => ({
      ...r,
      actor: r.actorUserId
        ? (actorMap.get(r.actorUserId) ?? { id: r.actorUserId })
        : null,
    }));

    return NextResponse.json({ events, nextCursor });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to read security audit log",
      error,
      { endpoint: "/api/security/audit" }
    );
    return NextResponse.json(
      { error: "Failed to read security audit log" },
      { status: 500 }
    );
  }
}
