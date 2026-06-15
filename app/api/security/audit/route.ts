import { and, count, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users, workflows } from "@/lib/db/schema";
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
    const resourceTypes = url.searchParams.getAll("resourceType");
    const resourceIds = url.searchParams.getAll("resourceId");
    const projectIds = url.searchParams.getAll("projectId");
    const tagIds = url.searchParams.getAll("tagId");
    const workflowIds = url.searchParams.getAll("workflowId");
    const actorUserIds = url.searchParams.getAll("actorUserId");
    const correlationId = url.searchParams.get("correlationId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const conditions = [eq(securityAuditLog.organizationId, organizationId)];
    if (action) {
      conditions.push(eq(securityAuditLog.action, action));
    }
    if (resourceTypes.length === 1) {
      conditions.push(eq(securityAuditLog.resourceType, resourceTypes[0]));
    } else if (resourceTypes.length > 1) {
      conditions.push(inArray(securityAuditLog.resourceType, resourceTypes));
    }

    // Resolve the relational resource filter entirely in the database. A
    // project or tag selection means "every event for that container AND for
    // the workflows currently under it"; the membership lookup is a single
    // org-scoped query, so the client never assembles the id set. Explicit
    // resourceId/workflowId selections are unioned in. When any resource
    // dimension is requested but resolves to no ids, the empty inArray yields
    // no rows -- the intended "nothing matches" result.
    const usesResourceFilter =
      resourceIds.length > 0 ||
      projectIds.length > 0 ||
      tagIds.length > 0 ||
      workflowIds.length > 0;
    if (usesResourceFilter) {
      const resourceIdSet = new Set<string>([
        ...resourceIds,
        ...workflowIds,
        ...projectIds,
        ...tagIds,
      ]);
      if (projectIds.length > 0 || tagIds.length > 0) {
        const membershipFilters = [
          ...(projectIds.length > 0
            ? [inArray(workflows.projectId, projectIds)]
            : []),
          ...(tagIds.length > 0 ? [inArray(workflows.tagId, tagIds)] : []),
        ];
        const owned = await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.organizationId, organizationId),
              or(...membershipFilters)
            )
          );
        for (const w of owned) {
          resourceIdSet.add(w.id);
        }
      }
      const ids = [...resourceIdSet];
      conditions.push(
        ids.length === 1
          ? eq(securityAuditLog.resourceId, ids[0])
          : inArray(securityAuditLog.resourceId, ids)
      );
    }
    if (actorUserIds.length === 1) {
      conditions.push(eq(securityAuditLog.actorUserId, actorUserIds[0]));
    } else if (actorUserIds.length > 1) {
      conditions.push(inArray(securityAuditLog.actorUserId, actorUserIds));
    }
    // Read one cascade back as a unit. ANDed with the org scope above, so a
    // correlation id can only ever surface the caller's own org's events.
    if (correlationId) {
      conditions.push(eq(securityAuditLog.correlationId, correlationId));
    }
    const fromDate = from ? new Date(from) : null;
    if (fromDate && !Number.isNaN(fromDate.getTime())) {
      conditions.push(gte(securityAuditLog.createdAt, fromDate));
    }
    const toDate = to ? new Date(to) : null;
    if (toDate && !Number.isNaN(toDate.getTime())) {
      conditions.push(lte(securityAuditLog.createdAt, toDate));
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
      // Expose only ip + country. userAgent is stored for forensics but the
      // UI never renders it, so it stays server-side.
      const meta = r.metadata as Record<string, unknown> | null;
      return {
        id: r.id,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        createdAt: r.createdAt,
        diff: redactAuditDiff(r.diff),
        metadata: meta
          ? { ip: meta.ip ?? null, country: meta.country ?? null }
          : null,
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
