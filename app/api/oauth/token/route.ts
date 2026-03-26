import { createHash, randomBytes } from "node:crypto";
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
      400
    );
  }

  const authCode = await getAuthCode(code);
  if (!authCode) {
    return jsonError("Invalid or expired authorization code", 400);
  }

  if (authCode.clientId !== clientId) {
    return jsonError("client_id mismatch", 400);
  }

  if (authCode.redirectUri !== redirectUri) {
    return jsonError("redirect_uri mismatch", 400);
  }

  if (authCode.codeChallengeMethod !== "S256") {
    return jsonError("Unsupported code_challenge_method", 400);
  }

  if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
    return jsonError("Invalid code_verifier", 400);
  }

  // Consume the code immediately (single use)
  await deleteAuthCode(code);

  const accessToken = createAccessToken({
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
      400
    );
  }

  const client = await getOAuthClient(clientId);
  if (!client) {
    return jsonError("Unknown client_id", 400);
  }

  const entry = await getRefreshToken(refreshTokenValue);
  if (!entry) {
    return jsonError("Invalid or expired refresh token", 400);
  }

  if (entry.clientId !== clientId) {
    return jsonError("client_id mismatch", 400);
  }

  // Rotate the refresh token
  await deleteRefreshToken(refreshTokenValue);

  const newRefreshToken = randomBytes(32).toString("hex");
  await storeRefreshToken({
    token: newRefreshToken,
    clientId,
    userId: entry.userId,
    organizationId: entry.organizationId,
    scope: entry.scope,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });

  const accessToken = createAccessToken({
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
    return Response.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfter) },
      }
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
      return jsonError("Invalid request body", 400);
    }
  }

  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    return await handleAuthorizationCode(params);
  }

  if (grantType === "refresh_token") {
    return await handleRefreshToken(params);
  }

  return jsonError(
    "Unsupported grant_type. Supported: authorization_code, refresh_token",
    400
  );
}
