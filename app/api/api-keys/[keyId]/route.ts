import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";
import { requireMfaEnrolled } from "@/lib/middleware/owner-mfa-guard";
import { notifyApiKeyChange } from "@/lib/security/api-key-notification";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

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
    // owner-role gate doesn't apply; require step-up at revoke time. Wallet
    // users authenticate by signature, so the TOTP-enrollment gate only
    // applies to email/TOTP accounts. Symmetric with creation.
    const isWallet = isWalletEmail(session.user.email);
    const sessionRow = session.session as { requiresMfa?: boolean | null };
    if (!isWallet) {
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
    }

    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      emailOtp?: string;
      signature?: string;
    };
    const stepUp = await requireStepUp({
      userId: session.user.id,
      email: session.user.email,
      action: "user_api_key_revoke",
      code: body.code,
      emailOtp: body.emailOtp,
      signature: body.signature,
      headers: request.headers,
    });
    if (!stepUp.ok) {
      return stepUpErrorResponse(stepUp);
    }

    // Delete the key (only if it belongs to the user)
    const [deleted] = await db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, session.user.id)))
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
      });

    if (!deleted) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    // Out-of-band alert symmetric with creation: the owner learns a bypass
    // credential was revoked even if their own session did it. Non-blocking.
    notifyApiKeyChange({
      email: session.user.email,
      action: "revoked",
      tokenName: deleted.name,
      keyPrefix: deleted.keyPrefix,
      when: new Date(),
    });

    // Durable forensic record of who revoked the key and from where.
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "api_key.revoked",
      resourceType: "api_key",
      resourceId: deleted.id,
      before: { name: deleted.name, keyPrefix: deleted.keyPrefix },
      metadata: buildAuditMetadata(request),
    });

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
