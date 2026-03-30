import { createHmac } from "node:crypto";

export type SessionPayload = {
  org: string;
  key: string;
  scope?: string;
  iat: number;
  exp: number;
  original_iat?: number;
};

export const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
export const MAX_RENEWAL_GRACE_SECONDS = 48 * 60 * 60; // 48 hours
export const MAX_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days

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
    original_iat: payload.original_iat ?? now,
  };
  const body = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${body}`;
  const signature = hmacSign(secret, signingInput);
  return `${signingInput}.${signature}`;
}

export type VerifyOptions = {
  allowExpired?: boolean;
};

export type VerifyResult =
  | { payload: SessionPayload; expired: false }
  | { payload: SessionPayload; expired: true }
  | {
      payload: null;
      expired: false;
      reason:
        | "invalid_signature"
        | "malformed"
        | "too_old"
        | "max_lifetime_exceeded";
    };

export function verifySessionToken(
  token: string,
  options?: VerifyOptions
): SessionPayload | null {
  const result = verifySessionTokenDetailed(token);
  if (!result.payload) {
    return null;
  }
  if (result.expired && !options?.allowExpired) {
    return null;
  }
  return result.payload;
}

export function verifySessionTokenDetailed(token: string): VerifyResult {
  try {
    const secret = getSessionSecret();
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { payload: null, expired: false, reason: "malformed" };
    }
    const [header, body, signature] = parts;
    const signingInput = `${header}.${body}`;
    const expectedSignature = hmacSign(secret, signingInput);

    if (signature !== expectedSignature) {
      return { payload: null, expired: false, reason: "invalid_signature" };
    }

    const payload = JSON.parse(base64UrlDecode(body)) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);

    const sessionOrigin = payload.original_iat ?? payload.iat;
    if (now - sessionOrigin > MAX_SESSION_LIFETIME_SECONDS) {
      return { payload: null, expired: false, reason: "max_lifetime_exceeded" };
    }

    if (payload.exp < now) {
      if (now - payload.exp > MAX_RENEWAL_GRACE_SECONDS) {
        return { payload: null, expired: false, reason: "too_old" };
      }
      return { payload, expired: true };
    }

    return { payload, expired: false };
  } catch {
    return { payload: null, expired: false, reason: "malformed" };
  }
}
