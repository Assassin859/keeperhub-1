import { eq } from "drizzle-orm";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hashSessionToken } from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  buildPendingOauthMfaSetCookie,
  encodePendingOauthMfaCookie,
} from "@/lib/oauth-mfa-cookie";

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
      return decodeURIComponent(value);
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
  if (res.status < 300 || res.status >= 400) {
    return res;
  }
  const setCookies =
    typeof (res.headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [];
  const sessionToken = extractSessionToken(setCookies);
  if (!sessionToken) {
    return res;
  }
  const tokenHash = hashSessionToken(sessionToken);
  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.token, tokenHash))
    .limit(1);
  if (!row) {
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
  if (!user || user.twoFactorEnabled !== true) {
    return res;
  }
  if (!user.email) {
    // Without an email we have no inbox to deliver the OTP to. Fall
    // through to Better Auth's default response so the user at least
    // gets a session; the proxy MFA gate will still send them to
    // /enroll-mfa or /verify-mfa.
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
  const verifyTarget = new URL("/verify-mfa", url.origin);
  verifyTarget.searchParams.set("next", originalRedirect);

  const pendingValue = encodePendingOauthMfaCookie(
    {
      userId: user.id,
      email: user.email,
      redirect: originalRedirect,
    },
    secret
  );

  const response = NextResponse.redirect(verifyTarget);
  for (const clear of buildSessionClearCookies()) {
    response.headers.append("Set-Cookie", clear);
  }
  response.headers.append(
    "Set-Cookie",
    buildPendingOauthMfaSetCookie(pendingValue)
  );
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
