import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { toChecksumAddress } from "@/lib/address-utils";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requireDualFactor } from "@/lib/mfa/dual-factor";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { requireOwnerWithMfa } from "@/lib/middleware/owner-mfa-guard";
import { exportKeyVerifySchema } from "@/lib/schemas/wallet";
import { exportTurnkeyPrivateKey } from "@/lib/turnkey/turnkey-client";
import { validateBody } from "@/lib/validate-request";
import { checkVerifyRateLimit } from "../_lib/rate-limit";

/**
 * POST /api/user/wallet/export-key/verify
 *
 * Exports a Turnkey wallet's private key in plaintext. Authorization
 * stack (every check must pass):
 *
 *   1. requireOwnerWithMfa  — org role = owner, users.two_factor_enabled
 *                              = true, sessions.requires_mfa = false.
 *   2. Wallet-creator check  — wallet.userId === session.user.id. The
 *                               TOTP secret belongs to the user, but the
 *                               wallet might have been created by a
 *                               different owner of the same org.
 *   3. Fresh TOTP challenge  — auth.api.verifyTOTP validates the code
 *                               the user just typed into the dialog.
 *                               This is the "step up at action time"
 *                               factor; passive session MFA is not
 *                               enough for an action that exfiltrates
 *                               signing material in plaintext.
 *
 * Replaces the previous wallet-inbox email-OTP factor. The old
 * /request endpoint that emailed a 6-digit code is gone; the UI now
 * prompts directly for a TOTP code from the user's authenticator.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const activeOrgId = getActiveOrgId(session);
    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const sessionRow = session.session as { requiresMfa?: boolean | null };
    const guard = await requireOwnerWithMfa(
      session.user.id,
      activeOrgId,
      sessionRow.requiresMfa === true
    );
    if (!guard.ok) {
      return NextResponse.json(
        { error: guard.error, code: guard.code },
        { status: guard.status }
      );
    }

    const rateLimit = checkVerifyRateLimit(session.user.id);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: "Too many verification attempts. Please wait before retrying.",
          retryAfter: rateLimit.retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfter) },
        }
      );
    }

    const bodyValidation = await validateBody(request, exportKeyVerifySchema);
    if (!bodyValidation.success) {
      return bodyValidation.response;
    }
    const body = bodyValidation.data;
    const dual = await requireDualFactor({
      userId: session.user.id,
      email: session.user.email,
      action: "wallet_export_key",
      code: body.code,
      emailOtp: body.emailOtp,
      headers: request.headers,
    });
    if (!dual.ok) {
      return NextResponse.json(
        { error: dual.error, code: dual.code },
        { status: dual.status }
      );
    }

    const wallets = await db
      .select()
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, activeOrgId))
      .limit(1);

    if (wallets.length === 0) {
      return NextResponse.json(
        { error: "No Turnkey wallet found" },
        { status: 404 }
      );
    }

    const wallet = wallets[0];

    if (wallet.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Only the wallet creator can export its private key" },
        { status: 403 }
      );
    }

    if (!wallet.turnkeySubOrgId) {
      return NextResponse.json(
        { error: "Turnkey wallet configuration is incomplete" },
        { status: 500 }
      );
    }

    const privateKey = await exportTurnkeyPrivateKey(
      wallet.turnkeySubOrgId,
      toChecksumAddress(wallet.walletAddress)
    );

    return NextResponse.json({ privateKey });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Wallet] Failed to verify and export private key",
      error,
      { endpoint: "/api/user/wallet/export-key/verify", operation: "post" }
    );
    return apiError(error, "Failed to export private key");
  }
}
