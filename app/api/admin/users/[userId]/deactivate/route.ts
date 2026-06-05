import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizationApiKeys, sessions, users } from "@/lib/db/schema";
import { authenticateKhAdmin } from "@/lib/kh-admin-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  const auth = authenticateKhAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { userId } = await context.params;

  try {
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!existing) {
        return { conflict: "not_found" as const };
      }
      if (existing.deactivatedAt) {
        return { conflict: "already_deactivated" as const };
      }

      await tx
        .update(users)
        .set({ deactivatedAt: now, updatedAt: now })
        .where(eq(users.id, userId));

      // Invalidate all active sessions immediately.
      await tx.delete(sessions).where(eq(sessions.userId, userId));

      // Revoke any org API keys this user created.
      await tx
        .update(organizationApiKeys)
        .set({ revokedAt: now })
        .where(
          and(
            eq(organizationApiKeys.createdBy, userId),
            isNull(organizationApiKeys.revokedAt)
          )
        );

      // DB triggers that fire automatically on users.deactivated_at update:
      //   cascade_user_deactivation (0085): deletes api_keys, mcp tokens, device codes
      //   cascade_org_deactivation_on_owner (0099): deactivates orgs where user
      //     was the sole active owner

      return { userId, deactivatedAt: now };
    });

    if ("conflict" in result) {
      if (result.conflict === "not_found") {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "User is already deactivated" }, { status: 409 });
    }

    return NextResponse.json(result);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[Admin] Failed to deactivate user", error, {
      userId,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
