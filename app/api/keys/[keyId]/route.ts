import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organizationApiKeys } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  dualFactorErrorResponse,
  requireDualFactor,
} from "@/lib/mfa/dual-factor";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireAdminOrOwnerWithMfa } from "@/lib/middleware/owner-mfa-guard";
import { notifyApiKeyChange } from "@/lib/security/api-key-notification";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

// DELETE - Revoke an API key
export async function DELETE(
  request: Request,
  context: { params: Promise<{ keyId: string }> }
) {
  try {
    const { keyId } = await context.params;
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId: activeOrgId } = authCtx;

    // Revoking an API key is symmetric with creating one — anything
    // that grants long-lived bypass deserves the same gate to remove.
    // Without this, an attacker on a session could rotate keys (delete
    // + recreate via a separate path) to lock owners out.
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const sessionRow = session.session as { requiresMfa?: boolean | null };
    const guard = await requireAdminOrOwnerWithMfa(
      session.user.id,
      activeOrgId,
      sessionRow.requiresMfa === true
    );
    if (!guard.ok) {
      return NextResponse.json(
        { error: guard.error, code: guard.code },
        { status: guard.status }
      );
    }

    // Dual-factor at revoke time. Same rationale as the create leg:
    // a stolen session must not be able to rotate keys (revoke + mint
    // elsewhere) without re-challenging on both factors.
    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      emailOtp?: string;
    };
    const dual = await requireDualFactor({
      userId: session.user.id,
      email: session.user.email,
      action: "org_api_key_revoke",
      code: body.code,
      emailOtp: body.emailOtp,
      headers: request.headers,
    });
    if (!dual.ok) {
      return dualFactorErrorResponse(dual);
    }

    // Revoke the key (soft delete) - only if it belongs to the organization
    const [revoked] = await db
      .update(organizationApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(organizationApiKeys.id, keyId),
          eq(organizationApiKeys.organizationId, activeOrgId)
        )
      )
      .returning({
        id: organizationApiKeys.id,
        name: organizationApiKeys.name,
        keyPrefix: organizationApiKeys.keyPrefix,
      });

    if (!revoked) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    console.log(
      `[API Keys] Revoked API key ${keyId} for organization ${activeOrgId}`
    );

    // Out-of-band alert + durable audit record, symmetric with user keys.
    notifyApiKeyChange({
      email: session.user.email,
      action: "revoked",
      tokenName: revoked.name,
      keyPrefix: revoked.keyPrefix,
      when: new Date(),
    });
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: activeOrgId,
        authMethod: "session",
      },
      action: "org_api_key.revoked",
      resourceType: "org_api_key",
      resourceId: revoked.id,
      before: { name: revoked.name, keyPrefix: revoked.keyPrefix },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[API Keys] Failed to revoke API key",
      error,
      { endpoint: "/api/keys/[keyId]", operation: "revoke" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to revoke API key",
      },
      { status: 500 }
    );
  }
}
