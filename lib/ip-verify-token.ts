import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-signed token carried in the /verify-ip URL we email after a
 * new-IP session is created. Clicking the link gets the user to the
 * verify page; the token by itself is not auth - the user still must
 * enter the emailed 6-digit code AND a TOTP code before the
 * verifications row at `mfa:ip_verify:<userId>` is accepted.
 *
 * Binding (sessionId + ip) into the signature means the link only
 * matches the specific session and IP that generated it. A link
 * shared, leaked, or replayed against another session is rejected.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export type IpVerifyTokenPayload = {
  userId: string;
  sessionId: string;
  ip: string;
  expiresAt: number;
};

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(
    createHmac("sha256", secret).update(payload).digest()
  );
}

export function encodeIpVerifyToken(
  payload: Omit<IpVerifyTokenPayload, "expiresAt">,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const full: IpVerifyTokenPayload = {
    ...payload,
    expiresAt: Date.now() + ttlMs,
  };
  const encoded = base64UrlEncode(JSON.stringify(full));
  const mac = sign(encoded, secret);
  return `${encoded}.${mac}`;
}

export type DecodeIpVerifyResult =
  | { ok: true; payload: IpVerifyTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function decodeIpVerifyToken(
  tokenValue: string,
  secret: string
): DecodeIpVerifyResult {
  const dot = tokenValue.indexOf(".");
  if (dot <= 0 || dot === tokenValue.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const encoded = tokenValue.slice(0, dot);
  const macClaim = tokenValue.slice(dot + 1);
  const macActual = sign(encoded, secret);
  const macClaimBuf = Buffer.from(macClaim);
  const macActualBuf = Buffer.from(macActual);
  if (macClaimBuf.length !== macActualBuf.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(macClaimBuf, macActualBuf)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: IpVerifyTokenPayload;
  try {
    payload = JSON.parse(
      base64UrlDecode(encoded).toString()
    ) as IpVerifyTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.userId !== "string" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.ip !== "string" ||
    typeof payload.expiresAt !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.expiresAt <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
