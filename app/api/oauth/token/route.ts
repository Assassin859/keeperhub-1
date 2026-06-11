import { createHash, randomBytes } from "node:crypto";
import { isUserDeactivated } from "@/lib/auth-deactivation-guard";
import { HttpStatus } from "@/lib/http-status";
import { createAccessToken } from "@/lib/mcp/oauth-auth";
import {
  deleteAuthCode,
  deleteRefreshToken,
  getAuthCode,
  getOAuthClient,
  getRefreshToken,
  REFRESH_TOKEN_TTL_MS,
  storeRefreshToken,
} from "@/lib/mcp/oauth-store";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";

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

async function handleAuthorizationCode(
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

async function handleRefreshToken(params: URLSearchParams): Promise<Response> {
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
      await handleAuthorizationCode(params),
      rateLimit
    );
  }

  if (grantType === "refresh_token") {
    return applyRateLimitHeaders(await handleRefreshToken(params), rateLimit);
  }

  return applyRateLimitHeaders(
    jsonError(
      "Unsupported grant_type. Supported: authorization_code, refresh_token",
      HttpStatus.BAD_REQUEST
    ),
    rateLimit
  );
}
