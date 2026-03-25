import { createHmac } from "node:crypto";

export type SessionPayload = {
  org: string;
  key: string;
  scope?: string;
  iat: number;
  exp: number;
};

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes

function getSessionSecret(): string {
  const secret =
    process.env.MCP_SESSION_SECRET ??
    process.env.OAUTH_JWT_SECRET ??
    process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "No session secret configured. Set MCP_SESSION_SECRET, OAUTH_JWT_SECRET, or BETTER_AUTH_SECRET."
    );
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
  const remainder = padded.length % 4;
  const withPadding =
    remainder > 0 ? `${padded}${"=".repeat(4 - remainder)}` : padded;
  return Buffer.from(withPadding, "base64").toString("utf8");
}

function hmacSign(secret: string, signingInput: string): string {
  return createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function createSessionToken(
  payload: Omit<SessionPayload, "iat" | "exp">
): string {
  const secret = getSessionSecret();
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionPayload = {
    org: payload.org,
    key: payload.key,
    scope: payload.scope,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const body = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${body}`;
  const signature = hmacSign(secret, signingInput);
  return `${signingInput}.${signature}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  try {
    const secret = getSessionSecret();
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [header, body, signature] = parts;
    const signingInput = `${header}.${body}`;
    const expectedSignature = hmacSign(secret, signingInput);

    if (signature !== expectedSignature) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(body)) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
