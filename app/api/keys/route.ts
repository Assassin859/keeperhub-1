import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organizationApiKeys, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  dualFactorErrorResponse,
  requireDualFactor,
} from "@/lib/mfa/dual-factor";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { getOrgContext } from "@/lib/middleware/org-context";
import { requireAdminOrOwnerWithMfa } from "@/lib/middleware/owner-mfa-guard";
import { notifyApiKeyChange } from "@/lib/security/api-key-notification";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

// Generate a secure API key with KeeperHub prefix
function generateApiKey(): { key: string; hash: string; prefix: string } {
  const randomPart = randomBytes(24).toString("base64url");
  const key = `kh_${randomPart}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 8); // "kh_" + first 5 chars
  return { key, hash, prefix };
}

// GET - List all API keys for the current organization
export async function GET(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId: activeOrgId } = authCtx;

    // List all non-revoked API keys for the organization
    const keys = await db.query.organizationApiKeys.findMany({
      where: and(
        eq(organizationApiKeys.organizationId, activeOrgId),
        isNull(organizationApiKeys.revokedAt)
      ),
      columns: {
        id: true,
        name: true,
        keyPrefix: true,
        createdBy: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });

    // Get unique creator IDs and fetch their names
    const creatorIds = [
      ...new Set(keys.map((k) => k.createdBy).filter(Boolean)),
    ] as string[];
    const creators =
      creatorIds.length > 0
        ? await db.query.users.findMany({
            where: inArray(users.id, creatorIds),
            columns: { id: true, name: true },
          })
        : [];
    const creatorMap = new Map(creators.map((u) => [u.id, u.name]));

    // Add createdByName to response
    const response = keys.map((key) => ({
      ...key,
      createdByName: key.createdBy
        ? creatorMap.get(key.createdBy) || null
        : null,
      createdBy: undefined,
    }));

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[API Keys] Failed to list API keys",
      error,
      { endpoint: "/api/keys", operation: "list" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list API keys",
      },
      { status: 500 }
    );
  }
}

// POST - Create a new API key for the current organization
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgContext = await getOrgContext();
    const activeOrgId = orgContext.organization?.id;

    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    // Check if user is anonymous
    const isAnonymous =
      session.user.name === "Anonymous" ||
      session.user.email?.startsWith("temp-");

    if (isAnonymous) {
      return NextResponse.json(
        { error: "Anonymous users cannot create API keys" },
        { status: 403 }
      );
    }

    // Creating an org API key mints a long-lived credential that
    // bypasses session MFA forever afterward, so gate the act of
    // minting with admin/owner role + MFA enrolled + step-up cleared.
    // Once issued the key itself is not MFA-aware; the time to enforce
    // is at creation.
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

    // Parse request body
    const body = await request.json().catch(() => ({}));

    // Dual-factor challenge — minting a forever-bypass credential
    // warrants both a fresh TOTP from the authenticator AND a fresh
    // email OTP from the user's inbox. Symmetric with withdraw /
    // export-key.
    const dual = await requireDualFactor({
      userId: session.user.id,
      email: session.user.email,
      action: "org_api_key_create",
      code: typeof body.code === "string" ? body.code : undefined,
      emailOtp: typeof body.emailOtp === "string" ? body.emailOtp : undefined,
      headers: request.headers,
    });
    if (!dual.ok) {
      return dualFactorErrorResponse(dual);
    }
    const name = body.name || null;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

    // Generate new API key
    const { key, hash, prefix } = generateApiKey();

    // Save to database
    const [newKey] = await db
      .insert(organizationApiKeys)
      .values({
        organizationId: activeOrgId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        createdBy: session.user.id,
        expiresAt,
      })
      .returning({
        id: organizationApiKeys.id,
        name: organizationApiKeys.name,
        keyPrefix: organizationApiKeys.keyPrefix,
        createdAt: organizationApiKeys.createdAt,
        expiresAt: organizationApiKeys.expiresAt,
      });

    console.log(
      `[API Keys] Created new API key for organization ${activeOrgId}: ${newKey.id}`
    );

    // Out-of-band alert + durable audit record, symmetric with user keys.
    notifyApiKeyChange({
      email: session.user.email,
      action: "created",
      tokenName: newKey.name,
      keyPrefix: newKey.keyPrefix,
      when: newKey.createdAt,
    });
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: activeOrgId,
        authMethod: "session",
      },
      action: "org_api_key.created",
      resourceType: "org_api_key",
      resourceId: newKey.id,
      after: { name: newKey.name, keyPrefix: newKey.keyPrefix },
      metadata: buildAuditMetadata(request),
    });

    // Return the full key only on creation (won't be shown again)
    return NextResponse.json({
      ...newKey,
      key, // Full key - only returned once!
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[API Keys] Failed to create API key",
      error,
      { endpoint: "/api/keys", operation: "create" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create API key",
      },
      { status: 500 }
    );
  }
}
