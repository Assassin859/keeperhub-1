import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readAllSetCookies } from "@/lib/auth-cookie-chain";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { verifyPassword } from "@/lib/password";

/**
 * First step of the strict atomic dual-factor sign-in.
 *
 * Validates the password against the user's credential account
 * directly (no cookies set, no Better Auth session machinery
 * touched) and, only on a successful match, triggers the email-OTP
 * send via Better Auth's emailOTP plugin so the standard
 * `sign-in-otp-<email>` verifications row gets seeded with the
 * encrypted code. The user then provides that code, plus their
 * TOTP, to /api/auth/strict-signin (the atomic complete step) which
 * verifies all three factors before any session is created.
 *
 * Password validation is done here rather than client-side because
 * we never want an email OTP minted for an email/password pair the
 * caller cannot prove. That keeps the email-flood surface tight
 * and matches what the atomic /complete endpoint requires.
 *
 * Success response is a uniform shape regardless of whether the
 * email exists, so the endpoint cannot be used as a user-
 * enumeration oracle. Wrong credentials get a 401.
 */

type Body = {
  email?: string;
  password?: string;
};

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "bad_body" },
      { status: 400 }
    );
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  if (!(email && password)) {
    return NextResponse.json(
      {
        error: "Email and password are required",
        code: "missing_credentials",
      },
      { status: 400 }
    );
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid sign-in", code: "invalid_signin" },
      { status: 401 }
    );
  }

  const [credentialAccount] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(
      and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential"))
    )
    .limit(1);
  if (!credentialAccount?.password) {
    return NextResponse.json(
      { error: "Invalid sign-in", code: "invalid_signin" },
      { status: 401 }
    );
  }

  const passwordOk = await verifyPassword(password, credentialAccount.password);
  if (!passwordOk) {
    return NextResponse.json(
      { error: "Invalid sign-in", code: "invalid_signin" },
      { status: 401 }
    );
  }

  // Users without TOTP enrolled bypass the dual-factor flow. Mint the
  // session directly via Better Auth's signInEmail and forward its
  // session cookies on the response so the client can hard-reload into
  // an authenticated state. Only users with two_factor_enabled=true
  // proceed to the email-OTP + TOTP atomic flow below.
  if (user.twoFactorEnabled !== true) {
    try {
      const signInRes = await auth.api.signInEmail({
        body: { email, password },
        headers: request.headers,
        returnHeaders: true,
      });
      const sessionCookies = readAllSetCookies(signInRes.headers);
      const response = NextResponse.json({ ok: true, signedIn: true });
      for (const cookie of sessionCookies) {
        response.headers.append("Set-Cookie", cookie);
      }
      return response;
    } catch (err) {
      logSystemError(
        ErrorCategory.AUTH,
        "[strict-signin.start] signInEmail failed for non-TOTP user",
        err,
        { endpoint: "/api/auth/strict-signin/start", user_id: user.id }
      );
      return NextResponse.json(
        { error: "Sign-in failed", code: "signin_failed" },
        { status: 500 }
      );
    }
  }

  // Trigger Better Auth's emailOTP sendVerificationOTP server-side so
  // the encrypted `sign-in-otp-<email>` verifications row is seeded
  // for /api/auth/strict-signin to compare against. Calling the plugin
  // API directly avoids a self-fetch over HTTP, which CodeQL flagged
  // as SSRF because `new URL(request.url).origin` reflects the
  // request's Host header.
  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: request.headers,
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[strict-signin.start] emailOTP send failed",
      err,
      { endpoint: "/api/auth/strict-signin/start", user_id: user.id }
    );
    return NextResponse.json(
      { error: "Failed to send confirmation email", code: "email_send_failed" },
      { status: 503 }
    );
  }

  // No session, no cookie, just a green light to proceed to email
  // OTP entry. The client retains the password locally to submit
  // along with the OTP + TOTP at the atomic complete step.
  return NextResponse.json({ ok: true });
}
