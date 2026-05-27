import { eq } from "drizzle-orm";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hashSessionToken } from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import {
  buildPendingOauthMfaSetCookie,
  encodePendingOauthMfaCookie,
} from "@/lib/oauth-mfa-cookie";
import {
  buildPendingSignupSetCookie,
  encodePendingSignupCookie,
} from "@/lib/pending-signup-cookie";

const handlers = toNextJsHandler(auth);

const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

/**
 * Read Better Auth's session-token cookie out of a Set-Cookie array.
 * Returns the raw token value the browser would send back, or null if
 * no session cookie was set. We need this to look up the just-minted
 * session row when intercepting the OAuth callback for a TOTP-enrolled
 * user.
 */
function extractSessionToken(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    const firstPair = raw.split(";")[0]?.trim();
    if (!firstPair) {
      continue;
    }
    const eq2 = firstPair.indexOf("=");
    if (eq2 <= 0) {
      continue;
    }
    const name = firstPair.slice(0, eq2);
    const value = firstPair.slice(eq2 + 1);
    if ((SESSION_COOKIE_NAMES as readonly string[]).includes(name)) {
      // Better Auth signs the session cookie via hono's
      // setSignedCookie, so the wire value is
      // `<rawToken>.<base64HmacSignature>`. The adapter stores
      // `hashSessionToken(rawToken)` in sessions.token, so we
      // need the raw token without the signature suffix.
      const decoded = decodeURIComponent(value);
      const dotIdx = decoded.lastIndexOf(".");
      return dotIdx > 0 ? decoded.slice(0, dotIdx) : decoded;
    }
  }
  return null;
}

/**
 * Build a Set-Cookie value that clears each session-cookie variant
 * Better Auth might have emitted. We strip ALL session cookies on the
 * interception path so neither the unprefixed nor the __Secure-
 * prefixed variant is left behind.
 */
function buildSessionClearCookies(): string[] {
  const secureSegment =
    process.env.NODE_ENV === "production" ? " Secure;" : "";
  return SESSION_COOKIE_NAMES.map(
    (name) => `${name}=; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=0`
  );
}

/**
 * Intercept Better Auth's OAuth callback response. When the user has
 * `users.two_factor_enabled = true`, we throw away the session Better
 * Auth just minted (delete the row, clear the cookie) and replace it
 * with a signed `pending_oauth_mfa` cookie that only the
 * /api/auth/oauth-mfa-finalize endpoint will accept along with both
 * MFA codes. No usable session exists between OAuth and the finalize
 * step, so a stolen cookie in this window carries no auth power.
 */
async function interceptOauthCallback(
  req: Request,
  res: Response
): Promise<Response> {
  const url = new URL(req.url);
  if (!/^\/api\/auth\/callback\/[^/]+$/.test(url.pathname)) {
    return res;
  }
  const provider = url.pathname.split("/").pop() ?? "oauth";
  if (res.status < 300 || res.status >= 400) {
    logSystemWarn(
      ErrorCategory.AUTH,
      "[oauth-callback] non-redirect response; skipping intercept",
      new Error("non_redirect_response"),
      {
        provider,
        status: String(res.status),
      }
    );
    return res;
  }
  const headersWithGetSetCookie = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const hasGetSetCookie = typeof headersWithGetSetCookie.getSetCookie === "function";
  const setCookies = hasGetSetCookie
    ? (headersWithGetSetCookie.getSetCookie as () => string[])()
    : [];
  const sessionToken = extractSessionToken(setCookies);
  if (!sessionToken) {
    logSystemWarn(
      ErrorCategory.AUTH,
      "[oauth-callback] no session token in Set-Cookie",
      new Error("no_session_token_in_set_cookie"),
      {
        provider,
        status: String(res.status),
        set_cookie_count: String(setCookies.length),
        has_get_set_cookie: String(hasGetSetCookie),
      }
    );
    return res;
  }
  const tokenHash = hashSessionToken(sessionToken);
  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.token, tokenHash))
    .limit(1);
  if (!row) {
    logSystemWarn(
      ErrorCategory.AUTH,
      "[oauth-callback] session row not found for emitted token",
      new Error("session_row_not_found"),
      {
        provider,
        token_hash_prefix: tokenHash.slice(0, 8),
      }
    );
    return res;
  }
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user || !user.email) {
    // Without an email we have no inbox to deliver an OTP to, so we
    // cannot defer the session for either flow. Fall through to
    // Better Auth's default response; the proxy MFA gate will still
    // send the user to /enroll-mfa via the existing path.
    logSystemWarn(
      ErrorCategory.AUTH,
      "[oauth-callback] user has no email; skipping intercept",
      new Error("user_email_missing"),
      {
        provider,
        user_id: row.userId,
        user_found: String(Boolean(user)),
      }
    );
    return res;
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[oauth-mfa] BETTER_AUTH_SECRET missing; cannot defer OAuth session",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: url.pathname }
    );
    return res;
  }

  // Wipe the session Better Auth just wrote. Any race between the
  // delete and a parallel request using the same cookie loses by
  // construction: subsequent getSession lookups will miss the row.
  await db.delete(sessions).where(eq(sessions.id, row.id));

  const originalRedirect = res.headers.get("location") ?? "/";
  const clearSessionCookies = buildSessionClearCookies();

  // Two paths depending on whether the user already has TOTP:
  //
  //   * twoFactorEnabled = true  -> they completed enrollment in a
  //     prior session. Defer via pending_oauth_mfa and route them to
  //     /verify-mfa where they prove email + TOTP via
  //     /api/auth/oauth-mfa-finalize, which mints the session for the
  //     first time post-MFA.
  //
  //   * twoFactorEnabled = false -> brand-new OAuth user (or existing
  //     OAuth user who never enrolled). Defer via pending_signup_mfa
  //     and route them to /enroll-mfa. The first-time TOTP enrollment
  //     mints the real session inside the enroll route once the user
  //     finishes the wizard. No usable session exists until that.
  if (user.twoFactorEnabled === true) {
    const pendingValue = encodePendingOauthMfaCookie(
      {
        userId: user.id,
        email: user.email,
        redirect: originalRedirect,
      },
      secret
    );
    const verifyTarget = new URL("/verify-mfa", url.origin);
    verifyTarget.searchParams.set("next", originalRedirect);
    const response = NextResponse.redirect(verifyTarget);
    for (const clear of clearSessionCookies) {
      response.headers.append("Set-Cookie", clear);
    }
    response.headers.append(
      "Set-Cookie",
      buildPendingOauthMfaSetCookie(pendingValue)
    );
    // biome-ignore lint/suspicious/noConsole: success-path trace; Sentry warn would be noise on every login
    console.info("[oauth-callback] pending_oauth_mfa_path", {
      provider,
      user_id: user.id,
    });
    return response;
  }

  const pendingSignupValue = encodePendingSignupCookie(
    {
      userId: user.id,
      email: user.email,
      provider,
      redirect: originalRedirect,
    },
    secret
  );
  const enrollTarget = new URL("/enroll-mfa", url.origin);
  enrollTarget.searchParams.set("next", originalRedirect);
  const response = NextResponse.redirect(enrollTarget);
  for (const clear of clearSessionCookies) {
    response.headers.append("Set-Cookie", clear);
  }
  response.headers.append(
    "Set-Cookie",
    buildPendingSignupSetCookie(pendingSignupValue)
  );
  // biome-ignore lint/suspicious/noConsole: success-path trace; Sentry warn would be noise on every login
  console.info("[oauth-callback] pending_signup_mfa_path", {
    provider,
    user_id: user.id,
  });
  return response;
}

/**
 * Block Better Auth's standalone /sign-in/email-otp endpoint for any
 * user whose two_factor_enabled flag is true. That endpoint mints a
 * session immediately on email-OTP verification, completely bypassing
 * TOTP. The strict atomic /api/auth/strict-signin endpoint is the
 * only sign-in surface for credential users with TOTP enrolled.
 */
async function blockEmailOtpForTotpUsers(
  req: Request
): Promise<NextResponse | null> {
  const url = new URL(req.url);
  if (!url.pathname.endsWith("/sign-in/email-otp")) {
    return null;
  }
  let body: { email?: string } = {};
  try {
    body = (await req.clone().json()) as { email?: string };
  } catch {
    return null;
  }
  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return null;
  }
  const [user] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (user?.twoFactorEnabled === true) {
    return NextResponse.json(
      {
        error:
          "This account requires the strict dual-factor sign-in flow. Sign in via the app's sign-in dialog.",
        code: "use_strict_signin",
      },
      { status: 403 }
    );
  }
  return null;
}

export async function GET(req: Request) {
  try {
    const res = await handlers.GET(req);
    return await interceptOauthCallback(req, res);
  } catch (error) {
    logSystemError(ErrorCategory.AUTH, "[Auth GET] Handler error:", error, {
      endpoint: "/api/auth",
      method: "GET",
    });
    throw error;
  }
}

export async function POST(req: Request) {
  try {
    const blocked = await blockEmailOtpForTotpUsers(req);
    if (blocked) {
      return blocked;
    }
    return await handlers.POST(req);
  } catch (error) {
    logSystemError(ErrorCategory.AUTH, "[Auth POST] Handler error:", error, {
      endpoint: "/api/auth",
      method: "POST",
    });
    throw error;
  }
}
