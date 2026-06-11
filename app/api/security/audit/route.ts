import { and, count, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { buildPage, parsePageRequest } from "@/lib/pagination";

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
    const req = parsePageRequest(url);
    const action = url.searchParams.get("action");
    const resourceType = url.searchParams.get("resourceType");
    const resourceId = url.searchParams.get("resourceId");
    const actorUserId = url.searchParams.get("actorUserId");
    const correlationId = url.searchParams.get("correlationId");

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
    // Read one cascade back as a unit. ANDed with the org scope above, so a
    // correlation id can only ever surface the caller's own org's events.
    if (correlationId) {
      conditions.push(eq(securityAuditLog.correlationId, correlationId));
    }
    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(securityAuditLog)
      .where(where);

    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(where)
      .orderBy(desc(securityAuditLog.createdAt))
      .limit(req.pageSize)
      .offset(req.offset);

    // Enrich actor ids -> name/email so the UI can show "who did it".
    const actorIds = [
      ...new Set(rows.map((r) => r.actorUserId).filter(Boolean)),
    ] as string[];
    const actors = actorIds.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, actorIds))
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    const items = rows.map((r) => {
      const enriched = r.actorUserId ? actorMap.get(r.actorUserId) : undefined;
      if (enriched) {
        return { ...r, actor: enriched };
      }
      // Fall back to the denormalized actor_label when the user row is gone
      // (a deletion cascade nulls actor_user_id) or no longer joinable, so the
      // trail still attributes the action instead of rendering as "System".
      if (r.actorLabel) {
        return { ...r, actor: { id: r.actorUserId, name: r.actorLabel } };
      }
      return { ...r, actor: r.actorUserId ? { id: r.actorUserId } : null };
    });

    return NextResponse.json(buildPage(items, total, req, url));
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
