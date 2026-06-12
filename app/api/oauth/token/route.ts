import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isUserDeactivated } from "@/lib/auth-deactivation-guard";
import { HttpStatus } from "@/lib/http-status";
import { createAccessToken } from "@/lib/mcp/oauth-auth";
import {
  deleteAuthCode,
  deleteRefreshToken,
  getAuthCode,
  getOAuthClient,
  getRefreshToken,
  type OAuthClient,
  REFRESH_TOKEN_TTL_MS,
  storeRefreshToken,
} from "@/lib/mcp/oauth-store";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { isUserMemberOfOrganization } from "@/lib/workflow/access";

export const dynamic = "force-dynamic";

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function verifyPkceS256(verifier: string, challenge: string): boolean {
  const hash = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return hash === challenge;
}

// Pull the client_secret from either the request body (client_secret_post) or
// the HTTP Basic Authorization header (client_secret_basic). Public PKCE
// clients send neither.
function extractClientSecret(
  request: Request,
  params: URLSearchParams
): string | null {
  const fromBody = params.get("client_secret");
  if (fromBody) {
    return fromBody;
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const secret = decoded.slice(decoded.indexOf(":") + 1);
    return secret || null;
  } catch {
    return null;
  }
}

function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(
    createHash("sha256").update(secret).digest("hex"),
    "utf8"
  );
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

// Only clients that registered a confidential auth method present a
// client_secret on token grants. Public PKCE clients (auth method "none", or
// rows predating the column that default to it) are identified by client_id
// alone and skip this check. Returns an error Response when verification
// fails, or null when the client is authenticated.
const CONFIDENTIAL_AUTH_METHODS = new Set([
  "client_secret_post",
  "client_secret_basic",
]);

function verifyClientAuthentication(
  client: OAuthClient,
  request: Request,
  params: URLSearchParams
): Response | null {
  if (!CONFIDENTIAL_AUTH_METHODS.has(client.tokenEndpointAuthMethod)) {
    return null;
  }
  const secret = extractClientSecret(request, params);
  if (!secret) {
    return jsonError("client_secret is required for this client", 401);
  }
  if (!secretMatches(secret, client.clientSecretHash)) {
    return jsonError("Invalid client_secret", 401);
  }
  return null;
}

async function handleAuthorizationCode(
  request: Request,
  params: URLSearchParams
): Promise<Response> {
  const code = params.get("code");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");

  if (!(code && clientId && redirectUri && codeVerifier)) {
    return jsonError(
      "Missing required parameters: code, client_id, redirect_uri, code_verifier",
      HttpStatus.BAD_REQUEST
    );
  }

  const client = await getOAuthClient(clientId);
  if (!client) {
    return jsonError("Unknown client_id", 400);
  }

  const clientAuthError = verifyClientAuthentication(client, request, params);
  if (clientAuthError) {
    return clientAuthError;
  }

  const authCode = await getAuthCode(code);
  if (!authCode) {
    return jsonError(
      "Invalid or expired authorization code",
      HttpStatus.BAD_REQUEST
    );
  }

  if (authCode.clientId !== clientId) {
    return jsonError("client_id mismatch", HttpStatus.BAD_REQUEST);
  }

  if (authCode.redirectUri !== redirectUri) {
    return jsonError("redirect_uri mismatch", HttpStatus.BAD_REQUEST);
  }

  if (authCode.codeChallengeMethod !== "S256") {
    return jsonError(
      "Unsupported code_challenge_method",
      HttpStatus.BAD_REQUEST
    );
  }

  if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
    return jsonError("Invalid code_verifier", HttpStatus.BAD_REQUEST);
  }

  // Consume the code immediately (single use)
  await deleteAuthCode(code);

  // Refuse to mint tokens if the user was deactivated between consenting
  // to the auth code and exchanging it. Without this, an auth code held
  // by an attacker would still buy a fresh access + refresh token pair.
  if (await isUserDeactivated(authCode.userId)) {
    return jsonError("User account is deactivated", HttpStatus.UNAUTHORIZED);
  }

  const accessToken = await createAccessToken({
    sub: authCode.userId,
    org: authCode.organizationId,
    scope: authCode.scope,
  });

  const refreshToken = randomBytes(32).toString("hex");
  await storeRefreshToken({
    token: refreshToken,
    clientId,
    userId: authCode.userId,
    organizationId: authCode.organizationId,
    scope: authCode.scope,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: authCode.scope,
  });
}

async function handleRefreshToken(
  request: Request,
  params: URLSearchParams
): Promise<Response> {
  const refreshTokenValue = params.get("refresh_token");
  const clientId = params.get("client_id");

  if (!(refreshTokenValue && clientId)) {
    return jsonError(
      "Missing required parameters: refresh_token, client_id",
      HttpStatus.BAD_REQUEST
    );
  }

  const client = await getOAuthClient(clientId);
  if (!client) {
    return jsonError("Unknown client_id", HttpStatus.BAD_REQUEST);
  }

  const clientAuthError = verifyClientAuthentication(client, request, params);
  if (clientAuthError) {
    return clientAuthError;
  }

  const entry = await getRefreshToken(refreshTokenValue);
  if (!entry) {
    return jsonError(
      "Invalid or expired refresh token",
      HttpStatus.BAD_REQUEST
    );
  }

  if (entry.clientId !== clientId) {
    return jsonError("client_id mismatch", HttpStatus.BAD_REQUEST);
  }

  // Rotate the refresh token
  await deleteRefreshToken(refreshTokenValue);

  // Refuse to mint tokens for a deactivated user. authenticateOAuthToken
  // already rejects existing access tokens on use; this closes the same
  // gap on the refresh-exchange path so a stolen refresh token cannot
  // survive deactivation by repeatedly cycling itself.
  if (await isUserDeactivated(entry.userId)) {
    return jsonError("User account is deactivated", HttpStatus.UNAUTHORIZED);
  }

  // Re-check org membership before re-issuing. A refresh token outlives any
  // single access token, so without this a user removed from (or who left)
  // the org could keep cycling the refresh token into fresh org-scoped
  // access tokens indefinitely.
  if (!(await isUserMemberOfOrganization(entry.userId, entry.organizationId))) {
    return jsonError("User is no longer a member of this organization", 401);
  }

  const newRefreshToken = randomBytes(32).toString("hex");
  await storeRefreshToken({
    token: newRefreshToken,
    clientId,
    userId: entry.userId,
    organizationId: entry.organizationId,
    scope: entry.scope,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });

  const accessToken = await createAccessToken({
    sub: entry.userId,
    org: entry.organizationId,
    scope: entry.scope,
  });

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: newRefreshToken,
    scope: entry.scope,
  });
}

export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const rateLimit = checkIpRateLimit(ip, 30, 60_000);
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      Response.json(
        { error: "Too many requests" },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rateLimit
    );
  }

  let params: URLSearchParams;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    params = new URLSearchParams(text);
  } else {
    try {
      const body = (await request.json()) as Record<string, string>;
      params = new URLSearchParams(body);
    } catch {
      return jsonError("Invalid request body", HttpStatus.BAD_REQUEST);
    }
  }

  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    return applyRateLimitHeaders(
      await handleAuthorizationCode(request, params),
      rateLimit
    );
  }

  if (grantType === "refresh_token") {
    return applyRateLimitHeaders(
      await handleRefreshToken(request, params),
      rateLimit
    );
  }

  return applyRateLimitHeaders(
    jsonError(
      "Unsupported grant_type. Supported: authorization_code, refresh_token",
      HttpStatus.BAD_REQUEST
    ),
    rateLimit
  );
}
