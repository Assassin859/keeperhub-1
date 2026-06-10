import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { buildCursorPage, parseCursorRequest } from "@/lib/pagination";

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
    const req = parseCursorRequest(url);
    const action = url.searchParams.get("action");
    const resourceType = url.searchParams.get("resourceType");
    const resourceId = url.searchParams.get("resourceId");
    const actorUserId = url.searchParams.get("actorUserId");

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
    if (req.cursor) {
      const cursorDate = new Date(req.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(
          req.direction === "next"
            ? lt(securityAuditLog.createdAt, cursorDate)
            : gt(securityAuditLog.createdAt, cursorDate)
        );
      }
    }

    // Fetch one extra row to derive the page boundary without a count query.
    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(and(...conditions))
      .orderBy(
        req.direction === "next"
          ? desc(securityAuditLog.createdAt)
          : asc(securityAuditLog.createdAt)
      )
      .limit(req.limit + 1);

    const { items: page, _links } = buildCursorPage(rows, req, url, (r) =>
      r.createdAt.toISOString()
    );

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
    const items = page.map((r) => ({
      ...r,
      actor: r.actorUserId
        ? (actorMap.get(r.actorUserId) ?? { id: r.actorUserId })
        : null,
    }));

    return NextResponse.json({ items, _links });
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
