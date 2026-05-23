import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organizationApiKeys, sessions, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * POST /api/user/delete
 * Deactivates the user account (soft delete)
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as {
      confirmation?: string;
      code?: string;
    };
    const { confirmation, code } = body;

    if (confirmation !== "DEACTIVATE") {
      return NextResponse.json(
        { error: "Please type DEACTIVATE to confirm" },
        { status: 400 }
      );
    }

    const userId = session.user.id;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (user.isAnonymous) {
      return NextResponse.json(
        { error: "Anonymous users cannot deactivate accounts" },
        { status: 403 }
      );
    }

    if (user.deactivatedAt) {
      return NextResponse.json(
        { error: "Account is already deactivated" },
        { status: 400 }
      );
    }

    // Fresh TOTP challenge for users who have MFA enrolled. Account
    // deletion is irreversible (from the user's perspective — it
    // cascades to sessions + revokes API keys + flips deactivatedAt
    // which the deactivation trigger then uses to cascade to wallets
    // etc.). A stolen session must not be able to nuke the account
    // without proving the second factor. Users without MFA enrolled
    // keep the DEACTIVATE-typed-confirmation as the only gate.
    if (user.twoFactorEnabled === true) {
      const totpCode = typeof code === "string" ? code.trim() : "";
      if (totpCode.length !== 6) {
        return NextResponse.json(
          {
            error: "A 6-digit verification code is required",
            code: "mfa_code_required",
          },
          { status: 400 }
        );
      }
      try {
        await auth.api.verifyTOTP({
          body: { code: totpCode },
          headers: request.headers,
        });
      } catch {
        return NextResponse.json(
          {
            error: "Invalid verification code",
            code: "mfa_code_invalid",
          },
          { status: 401 }
        );
      }
    }

    // Run the deactivation writes in one transaction so a partial failure
    // never leaves the user marked deactivated while their sessions or
    // API keys remain valid. authenticateApiKey gates on
    // users.deactivatedAt as defence-in-depth, but Better Auth's session
    // path does not, so without this transaction a session-delete failure
    // after the users row update would leave the account reachable via
    // session cookie until expiry.
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ deactivatedAt: now, updatedAt: now })
        .where(eq(users.id, userId));

      await tx.delete(sessions).where(eq(sessions.userId, userId));

      // Soft-revoke any organization API keys this user issued. Without
      // this, a kh_ key with createdBy = userId would survive deactivation
      // and remain usable until manually revoked.
      await tx
        .update(organizationApiKeys)
        .set({ revokedAt: now })
        .where(
          and(
            eq(organizationApiKeys.createdBy, userId),
            isNull(organizationApiKeys.revokedAt)
          )
        );
    });

    return NextResponse.json({
      success: true,
      message: "Account deactivated successfully",
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[User Delete] Failed to deactivate account:",
      error,
      {
        endpoint: "/api/user/delete",
        status_code: "500",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to deactivate account",
      },
      { status: 500 }
    );
  }
}
