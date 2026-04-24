import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { keyExportCodes, organizationWallets } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { checkRequestRateLimit } from "../_lib/rate-limit";

const CODE_EXPIRY_MINUTES = 5;

function generateOtp(): string {
  return crypto.randomInt(100_000, 999_999).toString();
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

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

    const activeMember = await auth.api.getActiveMember({
      headers: await headers(),
    });

    if (!activeMember) {
      return NextResponse.json(
        { error: "You are not a member of the active organization" },
        { status: 403 }
      );
    }

    const rateLimit = checkRequestRateLimit(session.user.id);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: "Too many export requests. Please wait before trying again.",
          retryAfter: rateLimit.retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfter) },
        }
      );
    }

    // Verify a Turnkey wallet exists (only Turnkey wallets are exportable;
    // Para wallets during migration are inactive and not exportable here)
    const turnkeyWallets = await db
      .select({
        id: organizationWallets.id,
        userId: organizationWallets.userId,
        email: organizationWallets.email,
      })
      .from(organizationWallets)
      .where(
        and(
          eq(organizationWallets.organizationId, activeOrgId),
          eq(organizationWallets.provider, "turnkey")
        )
      )
      .limit(1);

    if (turnkeyWallets.length === 0) {
      return NextResponse.json(
        { error: "No exportable wallet found" },
        { status: 404 }
      );
    }

    const wallet = turnkeyWallets[0];

    // Export must be initiated by the wallet creator, not just any org admin.
    if (wallet.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Only the wallet creator can export its private key" },
        { status: 403 }
      );
    }

    const walletEmail = wallet.email;

    // Delete any existing codes for this org
    await db
      .delete(keyExportCodes)
      .where(eq(keyExportCodes.organizationId, activeOrgId));

    // Generate and store new code
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

    await db.insert(keyExportCodes).values({
      organizationId: activeOrgId,
      codeHash: hashCode(code),
      expiresAt,
    });

    // The requester is always the wallet creator at this point (gated above);
    // the OTP is a second factor tied to the wallet's recovery inbox, which
    // may differ from the creator's account email.
    await sendEmail({
      to: walletEmail,
      subject: "Private Key Export Verification - KeeperHub",
      text: `A request to export the wallet's private key was made from your KeeperHub organization.\n\nYour verification code is: ${code}\n\nThis code expires in ${CODE_EXPIRY_MINUTES} minutes.\n\nIf you did not request this, please ignore this email.`,
      html: `
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a2e;">Private Key Export Verification</h2>
  <p>A request to export the wallet's private key was made from your KeeperHub organization.</p>
  <p>Your verification code is:</p>
  <div style="text-align: center; margin: 24px 0;">
    <div style="display: inline-block; background: #f5f5f5; padding: 16px 32px; border-radius: 8px; font-size: 28px; font-weight: bold; letter-spacing: 6px; font-family: monospace; color: #1a1a2e;">${code}</div>
  </div>
  <p style="color: #666; font-size: 13px;">This code expires in ${CODE_EXPIRY_MINUTES} minutes. If you did not request this, please ignore this email.</p>
</div>`.trim(),
    });

    return NextResponse.json({ sent: true, email: walletEmail });
  } catch (error) {
    return apiError(error, "Failed to send export verification code");
  }
}
