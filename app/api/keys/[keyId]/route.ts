import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organizationApiKeys } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireDualFactor } from "@/lib/mfa/dual-factor";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireAdminOrOwnerWithMfa } from "@/lib/middleware/owner-mfa-guard";
import { requireScope } from "@/lib/middleware/require-scope";

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
    // Defense-in-depth: this route is not OAuth-reachable today (the session +
    // admin/owner + dual-factor gates below reject a Bearer OAuth token), but
    // gate on write scope anyway so the A-03 class stays closed if that ordering
    // is ever refactored. Mirrors the sibling resolveOrganizationId mutations.
    const scopeError = requireScope(authCtx.scope, SCOPE_MCP_WRITE);
    if (scopeError) {
      return scopeError;
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
      return NextResponse.json(
        { error: dual.error, code: dual.code },
        { status: dual.status }
      );
    }

    // Revoke the key (soft delete) - only if it belongs to the organization
    const result = await db
      .update(organizationApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(organizationApiKeys.id, keyId),
          eq(organizationApiKeys.organizationId, activeOrgId)
        )
      )
      .returning({ id: organizationApiKeys.id });

    if (result.length === 0) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    console.log(
      `[API Keys] Revoked API key ${keyId} for organization ${activeOrgId}`
    );

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
