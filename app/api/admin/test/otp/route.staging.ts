import { symmetricDecrypt } from "better-auth/crypto";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authenticateAdmin, validateTestEmail } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { verifications } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function GET(request: Request): Promise<NextResponse> {
  const auth = authenticateAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  if (!email) {
    return NextResponse.json(
      { error: "Missing email query parameter" },
      { status: 400 }
    );
  }

  const emailError = validateTestEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError }, { status: 403 });
  }

  try {
    const identifier = `email-verification-otp-${email}`;
    const result = await db
      .select({ value: verifications.value })
      .from(verifications)
      .where(eq(verifications.identifier, identifier))
      .orderBy(desc(verifications.createdAt))
      .limit(1);

    if (result.length === 0 || !result[0].value) {
      return NextResponse.json(
        { error: `No OTP found for ${email}` },
        { status: 404 }
      );
    }

    // emailOTP stores `<encrypted>:<keyVersion>` when storeOTP is "encrypted"
    // (lib/auth.ts, KEEP-625). Strip the version suffix and decrypt the
    // ciphertext with BETTER_AUTH_SECRET to return the plaintext code.
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: "Server secret not configured" },
        { status: 500 }
      );
    }
    const ciphertext = result[0].value.split(":")[0];
    const otp = await symmetricDecrypt({ key: secret, data: ciphertext });
    return NextResponse.json({ otp });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Admin OTP lookup failed", error, {
      endpoint: "/api/admin/test/otp",
      operation: "get",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
