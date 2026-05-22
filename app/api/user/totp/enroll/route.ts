import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { twoFactor as twoFactorTable } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

type RequestBody = {
  code?: string;
};

type Response = {
  backupCodes: string[];
};

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

function generatePlainBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = generateRandomString(BACKUP_CODE_LENGTH, "a-z", "0-9", "A-Z");
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/**
 * POST /api/user/totp/enroll
 *
 * Atomic completion of TOTP enrollment: verifies the user's first TOTP
 * code (which also flips users.two_factor_enabled = true via the
 * plugin) and immediately mints + persists backup codes, returning the
 * plaintext set exactly once.
 *
 * This exists because backup-code generation is too important to leave
 * as a user-initiated follow-up step. A user who closes the dialog
 * after TOTP verify but before code generation would end up enrolled
 * with no recovery path. By coupling both writes into one endpoint, the
 * UI can guarantee that any enrolled user always had codes shown to
 * them at least once.
 *
 * Regenerate-later (replacing existing codes) still goes through the
 * separate /api/user/totp/backup-codes endpoint, which gates on a
 * fresh TOTP code because that flow invalidates a previously-shown set.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (isAnonymousUserShape(session.user)) {
    return NextResponse.json(
      { error: "Sign in with a real account to enable two-factor" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  // On first-time enrollment Better Auth's verifyTOTP rotates the
  // session (deletes the pre-2FA session and mints a new one, then
  // calls setSessionCookie on its internal response). returnHeaders:true
  // makes that Set-Cookie observable so we can forward it on our
  // NextResponse — without this the user is signed out the instant
  // they enter their first code because the new cookie never reaches
  // the browser.
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

  const userId = session.user.id;
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

    const responseBody: Response = { backupCodes };
    const response = NextResponse.json(responseBody);
    // Forward Better Auth's Set-Cookie (rotated session) to the
    // browser. We use append, not set, so multiple cookies (session
    // + session_data) are preserved.
    for (const [name, value] of verifyHeaders.entries()) {
      if (name.toLowerCase() === "set-cookie") {
        response.headers.append("set-cookie", value);
      }
    }
    return response;
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[TOTP Enroll] Failed to persist backup codes",
      error,
      { endpoint: "/api/user/totp/enroll", user_id: userId }
    );
    return NextResponse.json(
      { error: "Verification accepted but backup-code mint failed" },
      { status: 500 }
    );
  }
}
