import { createHmac } from "node:crypto";

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

function getJwtSecret(): string {
  const secret = process.env.OAUTH_JWT_SECRET;
  if (!secret) {
    throw new Error("OAUTH_JWT_SECRET environment variable is not set");
  }
  return secret;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64UrlDecode(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = 4 - (padded.length % 4);
  const withPadding = padding < 4 ? `${padded}${"=".repeat(padding)}` : padded;
  return Buffer.from(withPadding, "base64").toString("utf8");
}

export function createAccessToken(payload: {
  sub: string;
  org: string;
  scope: string;
}): string {
  const secret = getJwtSecret();
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims: OAuthTokenPayload = {
    sub: payload.sub,
    org: payload.org,
    scope: payload.scope,
    iat: now,
    exp: now + 3600, // 1 hour
  };
  const body = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${body}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `${signingInput}.${signature}`;
}

export function verifyAccessToken(token: string): OAuthTokenPayload | null {
  try {
    const secret = getJwtSecret();
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [header, body, signature] = parts;
    const signingInput = `${header}.${body}`;
    const expectedSignature = createHmac("sha256", secret)
      .update(signingInput)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    if (signature !== expectedSignature) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(body)) as OAuthTokenPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function authenticateOAuthToken(request: Request): OAuthAuthResult {
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

  const payload = verifyAccessToken(token);
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
