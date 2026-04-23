import { jwtVerify, SignJWT } from "jose";

export type OAuthTokenPayload = {
  sub: string;
  org: string;
  scope: string;
  exp: number;
  iat: number;
};

export type OAuthAuthResult = {
  authenticated: boolean;
  userId?: string;
  organizationId?: string;
  scope?: string;
  error?: string;
  statusCode?: number;
};

let cachedJwtSecret: { raw: string; encoded: Uint8Array } | null = null;

function getJwtSecret(): Uint8Array {
  const secret = process.env.OAUTH_JWT_SECRET;
  if (!secret) {
    throw new Error("OAUTH_JWT_SECRET environment variable is not set");
  }
  if (cachedJwtSecret?.raw === secret) {
    return cachedJwtSecret.encoded;
  }
  const encoded = new TextEncoder().encode(secret);
  cachedJwtSecret = { raw: secret, encoded };
  return encoded;
}

export async function createAccessToken(payload: {
  sub: string;
  org: string;
  scope: string;
}): Promise<string> {
  const secret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    sub: payload.sub,
    org: payload.org,
    scope: payload.scope,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600) // 1 hour
    .sign(secret);
}

function isOAuthTokenPayload(value: unknown): value is OAuthTokenPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.sub === "string" &&
    typeof p.org === "string" &&
    typeof p.scope === "string" &&
    typeof p.iat === "number" &&
    typeof p.exp === "number"
  );
}

export async function verifyAccessToken(
  token: string
): Promise<OAuthTokenPayload | null> {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    if (!isOAuthTokenPayload(payload)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function authenticateOAuthToken(
  request: Request
): Promise<OAuthAuthResult> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return {
      authenticated: false,
      error: "Missing Authorization header",
      statusCode: 401,
    };
  }

  if (!authHeader.startsWith("Bearer ")) {
    return {
      authenticated: false,
      error: "Invalid Authorization header format",
      statusCode: 401,
    };
  }

  const token = authHeader.substring(7);

  // kh_ tokens are handled by the API key auth, not here
  if (token.startsWith("kh_")) {
    return {
      authenticated: false,
      error: "Use API key authentication for kh_ tokens",
      statusCode: 401,
    };
  }

  const payload = await verifyAccessToken(token);
  if (!payload) {
    return {
      authenticated: false,
      error: "Invalid or expired OAuth token",
      statusCode: 401,
    };
  }

  if (!payload.org) {
    return {
      authenticated: false,
      error: "OAuth token missing organization claim",
      statusCode: 401,
    };
  }

  return {
    authenticated: true,
    userId: payload.sub,
    organizationId: payload.org,
    scope: payload.scope,
  };
}
