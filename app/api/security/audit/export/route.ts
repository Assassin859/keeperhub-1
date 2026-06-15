import { and, desc, eq, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { redactAuditDiff } from "@/lib/security/audit-redaction";
import { toCsvCell } from "@/lib/security/csv";

/**
 * Compliance export of the org's security audit trail as CSV. Same gate as the
 * read endpoint (session, org-scoped, owner/admin only). The diff column is
 * redacted server-side and emitted as a JSON string; internal columns
 * (apiKeyId, correlationId, outcome, ...) are not exported. Capped to keep the
 * response bounded; the paginated JSON endpoint serves deeper history.
 */

const MAX_EXPORT_ROWS = 50_000;

const COLUMNS = [
  "created_at",
  "action",
  "actor_name",
  "actor_email",
  "actor_role",
  "ip",
  "country",
  "resource_type",
  "resource_id",
  "diff",
] as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgCtx = await resolveOrganizationId(request);
    if ("error" in orgCtx) {
      return Response.json({ error: orgCtx.error }, { status: orgCtx.status });
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
      return Response.json(
        {
          error: "Only organization owners and admins can export the audit log",
        },
        { status: 403 }
      );
    }

    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.organizationId, organizationId))
      .orderBy(desc(securityAuditLog.createdAt))
      .limit(MAX_EXPORT_ROWS);

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

    const lines: string[] = [COLUMNS.join(",")];
    for (const r of rows) {
      const actor = r.actorUserId ? actorMap.get(r.actorUserId) : undefined;
      lines.push(
        [
          toCsvCell(r.createdAt.toISOString()),
          toCsvCell(r.action),
          toCsvCell(actor?.name ?? r.actorLabel ?? null),
          toCsvCell(actor?.email ?? null),
          toCsvCell(actor?.role ?? null),
          toCsvCell((r.metadata as { ip?: unknown } | null)?.ip ?? null),
          toCsvCell(
            (r.metadata as { country?: unknown } | null)?.country ?? null
          ),
          toCsvCell(r.resourceType),
          toCsvCell(r.resourceId),
          toCsvCell(redactAuditDiff(r.diff)),
        ].join(",")
      );
    }

    return new Response(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="audit-log.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to export security audit log",
      error,
      { endpoint: "/api/security/audit/export" }
    );
    return Response.json(
      { error: "Failed to export security audit log" },
      { status: 500 }
    );
  }
}
