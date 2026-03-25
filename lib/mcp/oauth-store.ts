import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpOauthClients, mcpOauthRefreshTokens } from "@/lib/db/schema";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type AuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  userId: string;
  organizationId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
};

export type RefreshTokenEntry = {
  token: string;
  clientId: string;
  userId: string;
  organizationId: string;
  scope: string;
  expiresAt: number;
};

export type OAuthClient = {
  clientId: string;
  clientSecretHash: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  grantTypes: string[];
  organizationId: string | null;
  createdAt: number;
};

// Auth codes stay in-memory (10min TTL, no need to persist across restarts)
const authCodes = new Map<string, AuthorizationCode>();

export function storeAuthCode(entry: AuthorizationCode): void {
  authCodes.set(entry.code, entry);
}

export function getAuthCode(code: string): AuthorizationCode | undefined {
  const entry = authCodes.get(code);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    authCodes.delete(code);
    return undefined;
  }
  return entry;
}

export function deleteAuthCode(code: string): void {
  authCodes.delete(code);
}

export function cleanupExpiredAuthCodes(): void {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (now > entry.expiresAt) {
      authCodes.delete(code);
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function storeOAuthClient(client: OAuthClient): Promise<void> {
  await db.insert(mcpOauthClients).values({
    clientId: client.clientId,
    clientSecretHash: client.clientSecretHash,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    scopes: client.scopes,
    grantTypes: client.grantTypes,
    organizationId: client.organizationId,
  });
}

export async function getOAuthClient(
  clientId: string
): Promise<OAuthClient | undefined> {
  const rows = await db
    .select()
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.clientId, clientId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return undefined;
  }

  return {
    clientId: row.clientId,
    clientSecretHash: row.clientSecretHash,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    scopes: row.scopes,
    grantTypes: row.grantTypes,
    organizationId: row.organizationId ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export async function storeRefreshToken(
  entry: RefreshTokenEntry
): Promise<void> {
  const tokenHash = hashToken(entry.token);
  await db.insert(mcpOauthRefreshTokens).values({
    tokenHash,
    clientId: entry.clientId,
    userId: entry.userId,
    organizationId: entry.organizationId,
    scope: entry.scope,
    expiresAt: new Date(entry.expiresAt),
  });
}

export async function getRefreshToken(
  token: string
): Promise<RefreshTokenEntry | undefined> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(mcpOauthRefreshTokens)
    .where(eq(mcpOauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return undefined;
  }

  if (Date.now() > row.expiresAt.getTime()) {
    await db
      .delete(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.tokenHash, tokenHash));
    return undefined;
  }

  return {
    token,
    clientId: row.clientId,
    userId: row.userId,
    organizationId: row.organizationId,
    scope: row.scope,
    expiresAt: row.expiresAt.getTime(),
  };
}

export async function deleteRefreshToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db
    .delete(mcpOauthRefreshTokens)
    .where(eq(mcpOauthRefreshTokens.tokenHash, tokenHash));
}

export { AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS };
