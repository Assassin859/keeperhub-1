import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type RequestBody = {
  code?: string;
  emailOtp?: string;
  signature?: string;
};

/**
 * POST /api/user/sessions/:sessionId/revoke
 *
 * Deletes a single session row owned by the caller. Used by the
 * Active sessions panel so a user can sign out a specific device
 * (a left-open browser, a session-cookie copy elsewhere, anything
 * they no longer trust) without affecting the device they're
 * currently using.
 *
 * Gated by `requireDualFactor` so a stolen session cookie alone
 * cannot weaponise this endpoint to nuke a user's other devices.
 * The current session cannot be revoked here; the regular sign-out
 * flow handles that and leaves no surprises about how the dialog
 * closes.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<NextResponse> {
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

  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json(
      { error: "Missing session id", code: "missing_session_id" },
      { status: 400 }
    );
  }

  const currentId = (session.session as { id?: string } | undefined)?.id;
  if (currentId && currentId === sessionId) {
    return NextResponse.json(
      {
        error:
          "Use sign-out to end your current session. This endpoint is for revoking other sessions.",
        code: "cannot_revoke_current",
      },
      { status: 400 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const emailOtp =
    typeof body.emailOtp === "string" ? body.emailOtp.trim() : "";
  const signature =
    typeof body.signature === "string" ? body.signature.trim() : undefined;

  const stepUp = await requireStepUp({
    userId: session.user.id,
    email: session.user.email,
    action: "session_revoke",
    code,
    emailOtp,
    signature,
    headers: request.headers,
  });
  if (!stepUp.ok) {
    return stepUpErrorResponse(stepUp);
  }

  try {
    const result = await db
      .delete(sessions)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, session.user.id))
      )
      .returning({ id: sessions.id });
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Session not found", code: "session_not_found" },
        { status: 404 }
      );
    }
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "session.revoked",
      resourceType: "session",
      resourceId: sessionId,
      metadata: buildAuditMetadata(request),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[sessions.revoke] failed to delete session row",
      err,
      {
        endpoint: "/api/user/sessions/:sessionId/revoke",
        user_id: session.user.id,
        target_session_id: sessionId,
      }
    );
    return NextResponse.json(
      { error: "Failed to revoke session", code: "revoke_failed" },
      { status: 500 }
    );
  }
}
