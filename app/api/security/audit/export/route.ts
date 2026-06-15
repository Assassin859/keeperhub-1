import { and, desc, eq, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, securityAuditLog, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { redactAuditDiff } from "@/lib/security/audit-redaction";

/**
 * Compliance export of the org's security audit trail as CSV. Same gate as the
 * read endpoint (session, org-scoped, owner/admin only). The diff column is
 * redacted server-side and emitted as a JSON string; internal columns
 * (apiKeyId, correlationId, outcome, ...) are not exported. Capped to keep the
 * response bounded; the paginated JSON endpoint serves deeper history.
 */

const MAX_EXPORT_ROWS = 50_000;
const CSV_SPECIAL = /[",\n\r]/;

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

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Quote and escape if the cell contains a comma, quote, or newline.
  if (CSV_SPECIAL.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

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
          csvCell(r.createdAt.toISOString()),
          csvCell(r.action),
          csvCell(actor?.name ?? r.actorLabel ?? null),
          csvCell(actor?.email ?? null),
          csvCell(actor?.role ?? null),
          csvCell((r.metadata as { ip?: unknown } | null)?.ip ?? null),
          csvCell(
            (r.metadata as { country?: unknown } | null)?.country ?? null
          ),
          csvCell(r.resourceType),
          csvCell(r.resourceId),
          csvCell(redactAuditDiff(r.diff)),
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
