import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requireDualFactor } from "@/lib/mfa/dual-factor";
import { requireMfaEnrolled } from "@/lib/middleware/owner-mfa-guard";

// DELETE - Delete an API key
export async function DELETE(
  request: Request,
  context: { params: Promise<{ keyId: string }> }
) {
  try {
    const { keyId } = await context.params;
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // User-scoped API keys (wfb_ prefix) aren't tied to an org so the
    // owner-role gate doesn't apply; require MFA enrolled + step-up
    // cleared. Symmetric with creation (same gate in POST).
    const sessionRow = session.session as { requiresMfa?: boolean | null };
    const guard = await requireMfaEnrolled(
      session.user.id,
      sessionRow.requiresMfa === true
    );
    if (!guard.ok) {
      return NextResponse.json(
        { error: guard.error, code: guard.code },
        { status: guard.status }
      );
    }

    // Dual-factor at revoke time. Symmetric with create.
    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      emailOtp?: string;
    };
    const dual = await requireDualFactor({
      userId: session.user.id,
      email: session.user.email,
      action: "user_api_key_revoke",
      code: body.code,
      emailOtp: body.emailOtp,
      headers: request.headers,
    });
    if (!dual.ok) {
      return NextResponse.json(
        { error: dual.error, code: dual.code },
        { status: dual.status }
      );
    }

    // Delete the key (only if it belongs to the user)
    const result = await db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, session.user.id)))
      .returning({ id: apiKeys.id });

    if (result.length === 0) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to delete API key", error, {
      endpoint: "/api/api-keys/[keyId]",
      operation: "delete",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete API key",
      },
      { status: 500 }
    );
  }
}
