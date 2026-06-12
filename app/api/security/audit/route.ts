import { and, count, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { redactAuditDiff } from "@/lib/security/audit-redaction";

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

    // Enrich actor ids -> name/email/role so the UI can identify "who did it"
    // unambiguously (the org role disambiguates same-named users). Role is the
    // actor's membership role in the caller's org (null if they are no longer a
    // member).
    const actorIds = [
      ...new Set(rows.map((r) => r.actorUserId).filter(Boolean)),
    ] as string[];
    const actors = actorIds.length
      ? await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: member.role,
          })
          .from(users)
          .leftJoin(
            member,
            and(
              eq(member.userId, users.id),
              eq(member.organizationId, organizationId)
            )
          )
          .where(inArray(users.id, actorIds))
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    // Return an explicit, display-only DTO -- never the raw row. Spreading the
    // row would leak internal audit columns (apiKeyId, authMethod,
    // correlationId, outcome, org/actor labels) and the unredacted diff to the
    // client. Only the fields the activity view consumes are exposed, and the
    // diff is redacted server-side so secrets never reach the wire.
    const items = rows.map((r) => {
      const enriched = r.actorUserId ? actorMap.get(r.actorUserId) : undefined;
      // Fall back to the denormalized actor_label when the user row is gone (a
      // deletion cascade nulls actor_user_id) so the trail still attributes the
      // action instead of rendering as "System".
      let actor: {
        id: string | null;
        name?: string | null;
        email?: string | null;
        role?: string | null;
      } | null = null;
      if (enriched) {
        actor = enriched;
      } else if (r.actorLabel) {
        actor = { id: r.actorUserId, name: r.actorLabel };
      } else if (r.actorUserId) {
        actor = { id: r.actorUserId };
      }
      return {
        id: r.id,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        createdAt: r.createdAt,
        diff: redactAuditDiff(r.diff),
        metadata: r.metadata,
        actor,
      };
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
