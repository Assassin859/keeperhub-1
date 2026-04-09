import { inArray, like, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import {
  member,
  organization,
  users,
  verifications,
  workflows,
} from "@/lib/db/schema";

const K6_EMAIL_PATTERN = "k6-%@techops.services";
const VERIFICATION_PATTERN = "email-verification-otp-k6-%@techops.services";

// Allowlist for identifiers returned by information_schema. Postgres unquoted
// identifiers are [a-zA-Z_][a-zA-Z0-9_]*; we restrict to that to make it
// impossible for a compromised information_schema lookup to inject SQL.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

type FkRow = { table_name: string; column_name: string };

export async function POST(request: Request): Promise<NextResponse> {
  const auth = authenticateAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: 401 }
    );
  }

  let body: { dryRun?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // default
  }

  try {
    const testUsers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(like(users.email, K6_EMAIL_PATTERN));

    if (testUsers.length === 0) {
      return NextResponse.json({
        deleted: { users: 0 },
        emails: [],
        dryRun: body.dryRun === true,
      });
    }

    const userIds = testUsers.map((u) => u.id);
    const emails = testUsers.map((u) => u.email).filter(Boolean) as string[];

    if (body.dryRun === true) {
      return NextResponse.json({
        deleted: { users: userIds.length },
        emails,
        dryRun: true,
      });
    }

    await db.transaction(async (tx) => {
      // Discover every table with a direct FK to users.id at runtime.
      // Future migrations that add user-scoped tables are picked up
      // automatically without needing to update this file.
      const fkRows = await tx.execute<FkRow>(sql`
        SELECT
          kcu.table_name::text AS table_name,
          kcu.column_name::text AS column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'users'
          AND ccu.column_name = 'id'
          AND tc.table_schema = 'public'
      `);

      // Resolve org IDs before deleting members (otherwise we lose the
      // mapping and the orgs become orphans).
      const orgRows = await tx
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(inArray(member.userId, userIds));
      const orgIds = [...new Set(orgRows.map((r) => r.organizationId))];

      // Disable workflows so the scheduler stops triggering them mid-cleanup.
      await tx
        .update(workflows)
        .set({ enabled: false })
        .where(inArray(workflows.userId, userIds));

      // Step 1: Delete transitively-dependent rows that have no direct FK to
      // users (and so don't appear in the discovery query).
      // workflow_execution_logs.execution_id -> workflow_executions.id
      // (no ON DELETE CASCADE on either link).
      await tx.execute(sql`
        DELETE FROM workflow_execution_logs
        WHERE execution_id IN (
          SELECT id FROM workflow_executions WHERE user_id = ANY(${userIds})
        )
      `);

      // Step 2: Delete from every discovered direct-FK table.
      // workflows must come last because workflow_executions.workflow_id
      // references it without ON DELETE CASCADE.
      const sortedTables = [...fkRows].sort((a, b) => {
        if (a.table_name === "workflows") {
          return 1;
        }
        if (b.table_name === "workflows") {
          return -1;
        }
        return 0;
      });

      for (const row of sortedTables) {
        if (
          !(IDENT_RE.test(row.table_name) && IDENT_RE.test(row.column_name))
        ) {
          throw new Error(
            `Invalid identifier from information_schema: ${row.table_name}.${row.column_name}`
          );
        }
        await tx.execute(sql`
          DELETE FROM ${sql.identifier(row.table_name)}
          WHERE ${sql.identifier(row.column_name)} = ANY(${userIds})
        `);
      }

      // Step 3: Verifications are identified by email pattern (no FK to users).
      await tx
        .delete(verifications)
        .where(like(verifications.identifier, VERIFICATION_PATTERN));

      // Step 4: Now-orphaned organizations.
      if (orgIds.length > 0) {
        await tx.delete(organization).where(inArray(organization.id, orgIds));
      }

      // Step 5: The users themselves.
      await tx.delete(users).where(inArray(users.id, userIds));
    });

    return NextResponse.json({
      deleted: { users: userIds.length },
      emails,
      dryRun: false,
    });
  } catch (error) {
    console.error("Admin cleanup failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
