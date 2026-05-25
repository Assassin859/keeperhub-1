import { and, desc, eq, gt } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  accounts,
  twoFactor as twoFactorTable,
  users,
  verifications,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { verifyPassword } from "@/lib/password";
import { verifyUserTotp } from "@/lib/security/totp-verify";

/**
 * Atomic strict dual-factor sign-in.
 *
 * Better Auth's stock flow falls down in two ways for our mandate:
 *
 *   1. `/sign-in/email-otp` mints a session as soon as the inbox code
 *      is verified. There is no TOTP gate on that path, so a caller
 *      who can read the encrypted OTP from the verifications row (DB
 *      read + BETTER_AUTH_SECRET) can sign in without TOTP.
 *   2. `/sign-in/email` -> `/two-factor/verify-totp` is the password
 *      + TOTP path, but it does not require an email OTP step. A
 *      stolen authenticator alone is sufficient.
 *
 * This endpoint requires ALL THREE factors in a single atomic
 * request. No session row is created unless password, email OTP and
 * TOTP all pass. Validations are done directly against the DB so we
 * never touch Better Auth's session machinery until every factor has
 * been confirmed; only then do we chain `signInEmail` + `verifyTOTP`
 * server-side to mint the session cookie and relay it back.
 *
 * The email-OTP row stays untouched on failure, so the user can
 * retry with the same code; on success the row is consumed.
 */

type Body = {
  email?: string;
  password?: string;
  emailOtp?: string;
  totpCode?: string;
};

function badRequest(error: string, code: string): NextResponse {
  return NextResponse.json({ error, code }, { status: 400 });
}

function unauthorized(error: string, code: string): NextResponse {
  return NextResponse.json({ error, code }, { status: 401 });
}

async function validateEmailOtp(
  email: string,
  providedOtp: string,
  serverSecret: string
): Promise<{ ok: true; rowId: string } | { ok: false }> {
  const identifier = `sign-in-otp-${email}`;
  const [row] = await db
    .select({ id: verifications.id, value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifier),
        gt(verifications.expiresAt, new Date())
      )
    )
    .orderBy(desc(verifications.expiresAt))
    .limit(1);
  if (!row) {
    return { ok: false };
  }
  // Better Auth's emailOTP plugin stores values as `<encrypted>:<keyVersion>`
  // when storeOTP is "encrypted". The version suffix isn't part of the
  // ciphertext, so strip it before passing to symmetricDecrypt.
  const ciphertext = row.value.split(":")[0];
  try {
    const decrypted = await symmetricDecrypt({
      key: serverSecret,
      data: ciphertext,
    });
    if (decrypted !== providedOtp) {
      return { ok: false };
    }
    return { ok: true, rowId: row.id };
  } catch {
    return { ok: false };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: atomic 3-factor validation with explicit early returns is the safest shape
export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest("Invalid JSON body", "bad_body");
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const emailOtp = body.emailOtp?.trim() ?? "";
  const totpCode = body.totpCode?.trim() ?? "";

  if (!(email && password)) {
    return badRequest("Email and password are required", "missing_credentials");
  }
  if (emailOtp.length !== 6) {
    return badRequest("Email code is required", "missing_email_otp");
  }
  if (totpCode.length !== 6) {
    return badRequest("Authenticator code is required", "missing_totp");
  }

  const serverSecret = process.env.BETTER_AUTH_SECRET;
  if (!serverSecret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[strict-signin] BETTER_AUTH_SECRET missing",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/auth/strict-signin" }
    );
    return NextResponse.json(
      { error: "Server misconfigured", code: "server_misconfigured" },
      { status: 500 }
    );
  }

  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] received", {
    email,
    passwordLen: password.length,
    emailOtpLen: emailOtp.length,
    totpCodeLen: totpCode.length,
  });

  // 1. Look up the user. Single not-found-or-mismatch response so this
  // endpoint cannot be used as a user-enumeration oracle.
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] user lookup", {
    found: Boolean(user),
    userId: user?.id,
  });
  if (!user) {
    return unauthorized("Invalid sign-in", "invalid_signin");
  }

  // 2. Validate password against the user's credential account.
  const [credentialAccount] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, user.id),
        eq(accounts.providerId, "credential")
      )
    )
    .limit(1);
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] credential account lookup", {
    found: Boolean(credentialAccount?.password),
    hashLen: credentialAccount?.password?.length ?? 0,
  });
  if (!credentialAccount?.password) {
    return unauthorized("Invalid sign-in", "invalid_signin");
  }
  const passwordOk = await verifyPassword(
    password,
    credentialAccount.password
  );
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] password verify", { passwordOk });
  if (!passwordOk) {
    return unauthorized("Invalid sign-in", "invalid_signin");
  }

  // 3. Validate the email OTP. Look-up only; do NOT consume yet.
  const emailOtpResult = await validateEmailOtp(
    email,
    emailOtp,
    serverSecret
  );
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] email OTP verify", {
    ok: emailOtpResult.ok,
    rowId: emailOtpResult.ok ? emailOtpResult.rowId : null,
  });
  if (!emailOtpResult.ok) {
    return unauthorized("Invalid email code", "invalid_email_otp");
  }

  // 4. Validate TOTP against the user's two_factor row.
  const [totpRow] = await db
    .select({ secret: twoFactorTable.secret })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, user.id))
    .limit(1);
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] totp row lookup", {
    found: Boolean(totpRow),
    secretLen: totpRow?.secret.length ?? 0,
  });
  if (!totpRow) {
    return unauthorized(
      "Two-factor not configured on this account",
      "totp_not_configured"
    );
  }
  const totpOk = await verifyUserTotp(
    totpRow.secret,
    totpCode,
    serverSecret
  );
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] totp verify", { totpOk });
  if (!totpOk) {
    return unauthorized("Invalid authenticator code", "invalid_totp");
  }
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] all three factors passed, minting session");

  // 5. All three factors verified. Consume the email-OTP row, then
  // chain Better Auth's standard flow to mint the session cookie.
  // signInEmail returns a Response with two_factor cookie; we extract
  // that and pass it into verifyTOTP, which then returns a Response
  // with the session cookie. Only the final session cookie is
  // forwarded to the client.
  try {
    await db.delete(verifications).where(eq(verifications.id, emailOtpResult.rowId));
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[strict-signin] Failed to consume email OTP row",
      err,
      { endpoint: "/api/auth/strict-signin", user_id: user.id }
    );
  }

  let twoFactorCookie = "";
  try {
    const signInRes = await auth.api.signInEmail({
      body: { email, password },
      headers: request.headers,
      returnHeaders: true,
    });
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] signInEmail returned", {
      hasHeaders: Boolean(signInRes?.headers),
      responseShape: Object.keys(signInRes ?? {}),
    });
    twoFactorCookie =
      signInRes.headers?.get?.("set-cookie") ?? "";
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] two_factor cookie extracted", {
      cookieLength: twoFactorCookie.length,
    });
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] signInEmail threw", err);
    logSystemError(
      ErrorCategory.AUTH,
      "[strict-signin] signInEmail chain failed after password validation",
      err,
      { endpoint: "/api/auth/strict-signin", user_id: user.id }
    );
    return NextResponse.json(
      { error: "Sign-in failed at session step", code: "session_failed" },
      { status: 500 }
    );
  }
  if (!twoFactorCookie) {
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] no two_factor cookie in signInEmail response");
    return NextResponse.json(
      { error: "Sign-in failed at session step", code: "session_failed" },
      { status: 500 }
    );
  }

  // Build a header set carrying the two_factor cookie that signInEmail
  // just minted, then call verifyTOTP with the user's authenticator
  // code. Better Auth's verifyTOTP completes the flow and returns the
  // session cookie. We must convert the Set-Cookie response header
  // value (`name=value; Path=/; HttpOnly; ...`) into a Cookie request
  // header value (`name=value`) by stripping every attribute after
  // the first `;` of each pair. A single Set-Cookie value can carry
  // multiple cookies if comma-joined, so split on `, ` boundaries that
  // are not inside an Expires date.
  function setCookieToCookieHeader(setCookieValue: string): string {
    // Split on comma followed by a space and a token-y char. This is
    // good enough for Better Auth's cookies which are simple ASCII
    // names; the more sophisticated split-set-cookie packages handle
    // Expires=Wed, 21 Oct 2015 7:28:00 GMT but Better Auth's cookies
    // use Max-Age, not Expires, so the simple split is safe here.
    const cookies = setCookieValue.split(/,(?=\s*[A-Za-z][A-Za-z0-9_.-]*=)/);
    return cookies
      .map((c) => c.split(";")[0].trim())
      .filter((p) => p.length > 0)
      .join("; ");
  }
  const chainedHeaders = new Headers(request.headers);
  // Replace any incoming cookie header so we don't accidentally pass
  // an old session cookie.
  chainedHeaders.set("cookie", setCookieToCookieHeader(twoFactorCookie));
  // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
  console.log("[strict-signin] chained cookie header", {
    rawSetCookieLen: twoFactorCookie.length,
    cookieHeader: chainedHeaders.get("cookie"),
  });

  let sessionSetCookies: string[] = [];
  try {
    const totpRes = await auth.api.verifyTOTP({
      body: { code: totpCode },
      headers: chainedHeaders,
      returnHeaders: true,
    });
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] verifyTOTP returned", {
      hasHeaders: Boolean(totpRes?.headers),
      responseShape: Object.keys(totpRes ?? {}),
    });
    // Better Auth's verifyTOTP returns multiple Set-Cookie headers (a
    // new session_token plus a clearing entry for the two_factor
    // cookie). Headers.get only returns the first / joined value; the
    // browser needs them as discrete Set-Cookie headers on the
    // outgoing response. Use getSetCookie() which gives us the array.
    const headersWithGetSetCookie = totpRes.headers as Headers & {
      getSetCookie?: () => string[];
    };
    if (typeof headersWithGetSetCookie.getSetCookie === "function") {
      sessionSetCookies = headersWithGetSetCookie.getSetCookie();
    } else {
      const single = totpRes.headers?.get?.("set-cookie");
      if (single) {
        sessionSetCookies = [single];
      }
    }
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] session cookies extracted", {
      count: sessionSetCookies.length,
      names: sessionSetCookies.map((c) => c.split("=")[0]),
    });
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] verifyTOTP threw", err);
    logSystemError(
      ErrorCategory.AUTH,
      "[strict-signin] verifyTOTP chain failed after TOTP validation",
      err,
      { endpoint: "/api/auth/strict-signin", user_id: user.id }
    );
    return NextResponse.json(
      { error: "Sign-in failed at session step", code: "session_failed" },
      { status: 500 }
    );
  }
  if (sessionSetCookies.length === 0) {
    // biome-ignore lint/suspicious/noConsole: diagnostic while wiring strict signin
    console.log("[strict-signin] no session cookies in verifyTOTP response");
    return NextResponse.json(
      { error: "Sign-in failed at session step", code: "session_failed" },
      { status: 500 }
    );
  }

  const response = NextResponse.json({ ok: true });
  for (const cookie of sessionSetCookies) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
