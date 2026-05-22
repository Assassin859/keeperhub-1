import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

type RequestBody = {
  code?: string;
};

/**
 * POST /api/user/totp/verify-stepup
 *
 * Clears the requires_mfa flag on the caller's session after a
 * successful TOTP verification. Used by the /verify-mfa page that the
 * UI redirects to whenever a session is quarantined by the login-risk
 * check in session.create.before.
 *
 * We wrap Better Auth's /api/auth/two-factor/verify-totp endpoint
 * rather than calling it directly because the plugin only flips its own
 * twoFactorEnabled flag on first verify; it doesn't know about our
 * sessions.requires_mfa column. Wrapping keeps the verification logic
 * in one place (plugin) and bolts our session-state update on top.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (isAnonymousUserShape(session.user)) {
    return NextResponse.json(
      { error: "Sign in with a real account" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  try {
    await auth.api.verifyTOTP({
      body: { code },
      headers: request.headers,
    });
  } catch {
    return NextResponse.json(
      { error: "Invalid verification code" },
      { status: 401 }
    );
  }

  try {
    await db
      .update(sessions)
      .set({ requiresMfa: false, mfaVerifiedAt: new Date() })
      .where(eq(sessions.id, session.session.id));
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[TOTP Verify Stepup] Failed to clear requires_mfa",
      error,
      {
        endpoint: "/api/user/totp/verify-stepup",
        user_id: session.user.id,
        session_id: session.session.id,
      }
    );
    return NextResponse.json(
      { error: "Verification accepted but session update failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ status: "ok" });
}
