import { randomBytes } from "node:crypto";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  hashSessionToken,
  signSessionCookieValue,
} from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import { sessions, twoFactor as twoFactorTable, users } from "@/lib/db/schema";
import { resolveEnrollMfaCaller } from "@/lib/enroll-mfa-caller";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  checkDualFactorRateLimit,
  resetDualFactor,
} from "@/lib/mfa/dual-factor-rate-limit";
import { buildPendingSignupClearCookie } from "@/lib/pending-signup-cookie";
import { resolveSigninDevice } from "@/lib/security/device-trust";
import {
  recordTrustedCountryFromRequest,
  resolveClientIpFromHeaders,
} from "@/lib/security/login-risk";
import { verifyUserTotp } from "@/lib/security/totp-verify";

type RequestBody = {
  code?: string;
};

type EnrollResponse = {
  backupCodes: string[];
  redirect?: string;
};

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generatePlainBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = generateRandomString(BACKUP_CODE_LENGTH, "a-z", "0-9", "A-Z");
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

function buildSessionSetCookie(signedValue: string, ttlMs: number): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  const cookieName =
    process.env.NODE_ENV === "production"
      ? "__Secure-better-auth.session_token"
      : "better-auth.session_token";
  return `${cookieName}=${encodeURIComponent(signedValue)}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * POST /api/user/totp/enroll
 *
 * Two auth shapes converge here:
 *
 *   - Sessioned caller: existing user upgrading from no-MFA to TOTP.
 *     Better Auth's verifyTOTP path is used so its session rotation
 *     + flip of users.two_factor_enabled = true are atomic with the
 *     plugin's own state. We also clear requires_mfa on every session
 *     this user holds, because the freshest possible TOTP proof is
 *     the one we just verified.
 *
 *   - Pending-signup caller: brand-new credential or OAuth user who
 *     carries only the signed pending_signup_mfa cookie, no session.
 *     We verify the TOTP code directly against the encrypted secret
 *     stored at /setup time, flip users.two_factor_enabled = true,
 *     and mint a fresh session for the first time. The session
 *     cookie returned here is the FIRST usable session for the
 *     account.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const caller = await resolveEnrollMfaCaller(request.headers);
  if (caller.kind === "anonymous") {
    if (caller.reason === "anonymous_user") {
      return NextResponse.json(
        { error: "Sign in with a real account to enable two-factor" },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[TOTP Enroll] BETTER_AUTH_SECRET is not configured",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/user/totp/enroll" }
    );
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  const userId = caller.userId;

  // Sessioned path: route through Better Auth so its rotation +
  // two_factor_enabled flip stay atomic with the plugin's state.
  if (caller.kind === "session") {
    let verifyHeaders: Headers;
    try {
      const result = await auth.api.verifyTOTP({
        body: { code },
        headers: request.headers,
        returnHeaders: true,
      });
      verifyHeaders = result.headers;
    } catch {
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 401 }
      );
    }

    try {
      const backupCodes = generatePlainBackupCodes();
      const encryptedBackupCodes = await symmetricEncrypt({
        key: secret,
        data: JSON.stringify(backupCodes),
      });
      await db
        .update(twoFactorTable)
        .set({ backupCodes: encryptedBackupCodes })
        .where(eq(twoFactorTable.userId, userId));
      await db
        .update(sessions)
        .set({ requiresMfa: false, mfaVerifiedAt: new Date() })
        .where(eq(sessions.userId, userId));
      const responseBody: EnrollResponse = { backupCodes };
      const response = NextResponse.json(responseBody);
      for (const [name, value] of verifyHeaders.entries()) {
        if (name.toLowerCase() === "set-cookie") {
          response.headers.append("set-cookie", value);
        }
      }
      return response;
    } catch (error) {
      logSystemError(
        ErrorCategory.AUTH,
        "[TOTP Enroll] Failed to persist backup codes (session path)",
        error,
        { endpoint: "/api/user/totp/enroll", user_id: userId }
      );
      return NextResponse.json(
        { error: "Verification accepted but backup-code mint failed" },
        { status: 500 }
      );
    }
  }

  // Pending-signup path: no session yet. Sliding-window rate limit
  // on the TOTP verify because the caller is unauthenticated by
  // session and Better Auth's per-route plugin rate limiter does not
  // wrap this code path. Without this, an attacker holding a stolen
  // pending_signup_mfa cookie could brute the 6-digit code for the
  // entire 30-min cookie TTL. Same sliding-window primitive used by
  // requireDualFactor; the counter is wiped on a successful verify
  // so a typo burst does not lock out a legitimate user.
  const rate = checkDualFactorRateLimit(userId, "totp_enroll");
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "Too many attempts. Wait and try again.",
        code: "rate_limited",
        retryAfter: rate.retryAfter,
      },
      { status: 429 }
    );
  }

  const [enrollment] = await db
    .select({ secret: twoFactorTable.secret })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, userId))
    .limit(1);
  if (!enrollment) {
    return NextResponse.json(
      { error: "No enrollment in progress for this user" },
      { status: 400 }
    );
  }
  const codeOk = await verifyUserTotp(enrollment.secret, code, secret);
  if (!codeOk) {
    return NextResponse.json(
      { error: "Invalid verification code" },
      { status: 401 }
    );
  }

  resetDualFactor(userId, "totp_enroll");

  try {
    const backupCodes = generatePlainBackupCodes();
    const encryptedBackupCodes = await symmetricEncrypt({
      key: secret,
      data: JSON.stringify(backupCodes),
    });

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
    const sessionId = `sess_${randomBytes(16).toString("base64url")}`;
    const userAgent = request.headers.get("user-agent") ?? null;
    const ipAddress = resolveClientIpFromHeaders(request.headers);

    // Single transaction across the three writes so a mid-flight
    // failure cannot leave the account in a "twoFactorEnabled = true
    // but no session row" state. A partial commit would brick the
    // user: the next request would route them through MFA gates
    // they can satisfy, but no session means they would never
    // authenticate, while the absence of the pending cookie (which
    // we are about to clear) means they could not retry enrollment.
    await db.transaction(async (tx) => {
      await tx
        .update(twoFactorTable)
        .set({ backupCodes: encryptedBackupCodes })
        .where(eq(twoFactorTable.userId, userId));
      await tx
        .update(users)
        .set({ twoFactorEnabled: true })
        .where(eq(users.id, userId));
      await tx.insert(sessions).values({
        id: sessionId,
        userId,
        token: tokenHash,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress,
        userAgent,
        requiresMfa: false,
        mfaVerifiedAt: new Date(),
      });
    });

    // This path mints the first session by hand, so the
    // session.create.before hook that normally records the source country
    // in user_trusted_countries never runs. Trust the signup country here
    // (first attestation) so a later sign-in from it isn't bounced to
    // /verify-ip for a country the user already signed up from.
    await recordTrustedCountryFromRequest(userId);

    const responseBody: EnrollResponse = {
      backupCodes,
      redirect: caller.redirect || "/",
    };
    const response = NextResponse.json(responseBody);
    response.headers.append(
      "Set-Cookie",
      buildSessionSetCookie(
        signSessionCookieValue(rawToken, secret),
        DEFAULT_SESSION_TTL_MS
      )
    );
    response.headers.append("Set-Cookie", buildPendingSignupClearCookie());
    // Register this as the account's first device (no warning email).
    const deviceSetCookie = await resolveSigninDevice({
      userId,
      email: caller.email,
      country: null,
      request,
    });
    if (deviceSetCookie) {
      response.headers.append("Set-Cookie", deviceSetCookie);
    }
    return response;
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[TOTP Enroll] Failed to finalize pending-signup enrollment",
      error,
      { endpoint: "/api/user/totp/enroll", user_id: userId }
    );
    return NextResponse.json(
      { error: "Verification accepted but enrollment finalize failed" },
      { status: 500 }
    );
  }
}
