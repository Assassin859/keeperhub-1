import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  hashSessionToken,
  signSessionCookieValue,
} from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import {
  sessions,
  twoFactor as twoFactorTable,
  userTrustedIps,
  verifications,
} from "@/lib/db/schema";
import { sendVerificationOTP } from "@/lib/email";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  checkDualFactorRateLimit,
  resetDualFactor,
} from "@/lib/mfa/dual-factor-rate-limit";
import {
  buildPendingIpClearCookie,
  decodePendingIpCookie,
  readPendingIpCookie,
} from "@/lib/pending-ip-cookie";
import {
  assessIpTrust,
  buildRiskFlagsJsonForIp,
  clearTrustCacheEntry,
} from "@/lib/security/login-risk";
import { verifyUserTotp } from "@/lib/security/totp-verify";
import { generateId } from "@/lib/utils/id";

/**
 * Completes the deferred dual-factor sign-in for a request that
 * arrived from an IP the user has never signed in from. The atomic
 * sign-in routes (strict-signin, oauth-mfa-finalize) set a signed
 * `pending_ip_verify` cookie and route the user here without
 * minting a session. The cookie alone confers no auth power: a
 * thief who exfiltrates it from another network cannot finish
 * because the IP attested at issue time is bound into the payload
 * and re-checked on every call here.
 *
 * Dual-factor model mirrors lib/mfa/dual-factor.ts but cannot use
 * the `requireDualFactor` helper directly because that primitive
 * verifies TOTP via `auth.api.verifyTOTP`, which requires an
 * existing session. /verify-ip is the one place in the codebase
 * where the user is identified but has no session. We verify TOTP
 * straight against the user's encrypted `two_factor.secret` via
 * `verifyUserTotp`, the same primitive strict-signin uses for the
 * very first authentication.
 */

type Body = {
  code?: string;
  emailOtp?: string;
};

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_OTP_TTL_MINUTES = 5;
const ACTION = "verify_ip";

function buildSessionSetCookie(signedValue: string, ttlMs: number): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  const cookieName =
    process.env.NODE_ENV === "production"
      ? "__Secure-better-auth.session_token"
      : "better-auth.session_token";
  return `${cookieName}=${encodeURIComponent(signedValue)}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

function generateEmailOtp(): string {
  return randomInt(100_000, 999_999).toString();
}

function identifierFor(userId: string): string {
  return `mfa:${ACTION}:${userId}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: Request): Promise<NextResponse> {
  const serverSecret = process.env.BETTER_AUTH_SECRET;
  if (!serverSecret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[verify-ip] BETTER_AUTH_SECRET missing",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/user/verify-ip" }
    );
    return NextResponse.json(
      { error: "Server misconfigured", code: "server_misconfigured" },
      { status: 500 }
    );
  }

  const cookieValue = readPendingIpCookie(request.headers);
  if (!cookieValue) {
    return NextResponse.json(
      {
        error: "No pending IP verification",
        code: "no_pending_ip",
      },
      { status: 401 }
    );
  }
  const decoded = decodePendingIpCookie(cookieValue, serverSecret);
  if (!decoded.ok) {
    return NextResponse.json(
      {
        error:
          decoded.reason === "expired"
            ? "Verification window expired. Sign in again."
            : "Invalid verification state. Sign in again.",
        code: decoded.reason,
      },
      { status: 401 }
    );
  }

  // Bind the dual-factor exchange to the IP that the cookie was
  // issued for. A thief on a different network cannot satisfy the
  // gate even with valid factors because assessIpTrust here will
  // resolve a different IP than the one stored in the payload.
  const ipTrust = await assessIpTrust(decoded.payload.userId);
  if (ipTrust.ip && ipTrust.ip !== decoded.payload.ip) {
    return NextResponse.json(
      {
        error: "Verification must be completed from the same network.",
        code: "ip_mismatch",
      },
      { status: 401 }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "bad_body" },
      { status: 400 }
    );
  }
  const totpCode = typeof body.code === "string" ? body.code.trim() : "";
  const inboxCode =
    typeof body.emailOtp === "string" ? body.emailOtp.trim() : "";

  const rateLimit = checkDualFactorRateLimit(decoded.payload.userId, ACTION);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many attempts. Wait and try again.",
        code: "rate_limited",
        retryAfter: rateLimit.retryAfter,
      },
      { status: 429 }
    );
  }

  const bothPresent = totpCode.length === 6 && inboxCode.length === 6;

  if (!bothPresent) {
    const otp = generateEmailOtp();
    const encrypted = await symmetricEncrypt({
      key: serverSecret,
      data: otp,
    });
    const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MINUTES * 60 * 1000);
    const identifier = identifierFor(decoded.payload.userId);
    await db
      .delete(verifications)
      .where(eq(verifications.identifier, identifier));
    await db.insert(verifications).values({
      id: generateId(),
      identifier,
      value: encrypted,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sent = await sendVerificationOTP({
      email: decoded.payload.email,
      otp,
      type: "confirm-action",
    });
    if (!sent) {
      return NextResponse.json(
        {
          error: "Failed to send confirmation email",
          code: "email_send_failed",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        error:
          "Enter the 6-digit code from your authenticator app and the code emailed to you.",
        code: "factors_required",
      },
      { status: 401 }
    );
  }

  const [totpRow] = await db
    .select({ secret: twoFactorTable.secret })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, decoded.payload.userId))
    .limit(1);
  if (!totpRow) {
    return NextResponse.json(
      {
        error: "Two-factor not configured on this account",
        code: "totp_not_configured",
      },
      { status: 401 }
    );
  }
  const totpOk = await verifyUserTotp(totpRow.secret, totpCode, serverSecret);
  if (!totpOk) {
    return NextResponse.json(
      { error: "Invalid authenticator code", code: "mfa_code_invalid" },
      { status: 401 }
    );
  }

  const identifier = identifierFor(decoded.payload.userId);
  const [row] = await db
    .select({ id: verifications.id, value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifier),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!row) {
    return NextResponse.json(
      {
        error: "Email code expired. Request a new one.",
        code: "email_code_invalid",
      },
      { status: 401 }
    );
  }
  let decryptedOtp: string;
  try {
    decryptedOtp = await symmetricDecrypt({
      key: serverSecret,
      data: row.value,
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[verify-ip] failed to decrypt stored email OTP",
      err,
      { endpoint: "/api/user/verify-ip", user_id: decoded.payload.userId }
    );
    return NextResponse.json(
      { error: "Server misconfigured", code: "server_misconfigured" },
      { status: 500 }
    );
  }
  if (!constantTimeEquals(decryptedOtp, inboxCode)) {
    return NextResponse.json(
      { error: "Invalid email code", code: "email_code_invalid" },
      { status: 401 }
    );
  }

  // Both factors verified and IP matches the cookie. Consume the
  // email-OTP row, mint a fully-MFA-verified session, and record the
  // IP as trusted for this user. The hash-token wrapper applies to
  // Better Auth's adapter calls, not direct Drizzle inserts, so hash
  // the token explicitly before storing.
  try {
    await db.delete(verifications).where(eq(verifications.id, row.id));
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[verify-ip] failed to consume email OTP row after success",
      err,
      { endpoint: "/api/user/verify-ip", user_id: decoded.payload.userId }
    );
  }
  resetDualFactor(decoded.payload.userId, ACTION);

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
  const sessionId = `sess_${randomBytes(16).toString("base64url")}`;
  const userAgent = request.headers.get("user-agent") ?? null;
  const ipAddress = decoded.payload.ip;

  // Capture geolocation for the active-sessions panel. The pending
  // cookie carries the country attested at strict-signin time; the
  // shared helper layers region + city via the IP-to-location
  // provider abstraction and serializes the same JSON shape Better
  // Auth's session.create.before path writes, so downstream readers
  // don't have to special-case rows minted on this path.
  const riskFlagsJson = await buildRiskFlagsJsonForIp(
    ipAddress,
    decoded.payload.country
  );

  try {
    await db.transaction(async (tx) => {
      await tx.insert(sessions).values({
        id: sessionId,
        userId: decoded.payload.userId,
        token: tokenHash,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress,
        userAgent,
        requiresMfa: false,
        mfaVerifiedAt: new Date(),
        riskFlagsJson,
      });
      await tx
        .insert(userTrustedIps)
        .values({
          userId: decoded.payload.userId,
          ip: decoded.payload.ip,
          country: decoded.payload.country,
        })
        .onConflictDoUpdate({
          target: [userTrustedIps.userId, userTrustedIps.ip],
          set: { lastSeenAt: new Date() },
        });
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[verify-ip] failed to insert session + trusted IP",
      err,
      { endpoint: "/api/user/verify-ip", user_id: decoded.payload.userId }
    );
    return NextResponse.json(
      { error: "Failed to create session", code: "session_create_failed" },
      { status: 500 }
    );
  }

  // Same-pod cache invalidation so the next request on this pod sees the
  // freshly-trusted IP without waiting for the UNTRUSTED_TTL_MS window in
  // the proxy gate. Cross-pod stale entries age out on their own.
  clearTrustCacheEntry(decoded.payload.userId, decoded.payload.ip);

  const response = NextResponse.json({
    ok: true,
    redirect: decoded.payload.redirect || "/",
  });
  response.headers.append(
    "Set-Cookie",
    buildSessionSetCookie(
      signSessionCookieValue(rawToken, serverSecret),
      DEFAULT_SESSION_TTL_MS
    )
  );
  response.headers.append("Set-Cookie", buildPendingIpClearCookie());
  return response;
}
