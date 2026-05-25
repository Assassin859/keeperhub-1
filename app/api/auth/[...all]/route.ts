import { eq } from "drizzle-orm";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

const handlers = toNextJsHandler(auth);

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
    return await handlers.GET(req);
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
