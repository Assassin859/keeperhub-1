import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, organizationApiKeys, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { normalizeScope } from "@/lib/mcp/oauth-scopes";
import {
  dualFactorErrorResponse,
  requireDualFactor,
} from "@/lib/mfa/dual-factor";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { getOrgContext } from "@/lib/middleware/org-context";
import { requireAdminOrOwnerWithMfa } from "@/lib/middleware/owner-mfa-guard";
import { buildPage, parsePageRequest } from "@/lib/pagination";
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

    const url = new URL(request.url);
    const req = parsePageRequest(url);
    const where = and(
      eq(organizationApiKeys.organizationId, activeOrgId),
      isNull(organizationApiKeys.revokedAt)
    );

    const [{ total }] = await db
      .select({ total: count() })
      .from(organizationApiKeys)
      .where(where);

    const keys = await db.query.organizationApiKeys.findMany({
      where,
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
      limit: req.pageSize,
      offset: req.offset,
    });

    // Enrich creators with name + email + org role so the key-activity
    // fallback can identify them as fully as a real audit event.
    const creatorIds = [
      ...new Set(keys.map((k) => k.createdBy).filter(Boolean)),
    ] as string[];
    const creators =
      creatorIds.length > 0
        ? await db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              role: member.role,
            })
            .from(users)
            .leftJoin(
              member,
              and(
                eq(member.userId, users.id),
                eq(member.organizationId, activeOrgId)
              )
            )
            .where(inArray(users.id, creatorIds))
        : [];
    const creatorMap = new Map(creators.map((u) => [u.id, u]));

    const items = keys.map((key) => {
      const creator = key.createdBy ? creatorMap.get(key.createdBy) : undefined;
      return {
        ...key,
        createdByName: creator?.name ?? null,
        createdByEmail: creator?.email ?? null,
        createdByRole: creator?.role ?? null,
        createdBy: undefined,
      };
    });

    return NextResponse.json(buildPage(items, total, req, url));
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
    let scopeInput: string | null = null;
    if (Array.isArray(body.scopes)) {
      scopeInput = (body.scopes as string[]).join(" ");
    } else if (typeof body.scopes === "string") {
      scopeInput = body.scopes;
    }
    const scope = scopeInput ? normalizeScope(scopeInput) : null;

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
        scope,
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
