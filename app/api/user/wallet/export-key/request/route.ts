import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { keyExportCodes, organizationWallets } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email";
import { getActiveOrgId } from "@/lib/middleware/org-context";

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

    if (activeMember.role !== "admin" && activeMember.role !== "owner") {
      return NextResponse.json(
        { error: "Only admins and owners can export wallet keys" },
        { status: 403 }
      );
    }

    // Verify a Turnkey wallet exists
    const turnkeyWallets = await db
      .select({ id: organizationWallets.id })
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, activeOrgId))
      .limit(1);

    if (turnkeyWallets.length === 0) {
      return NextResponse.json(
        { error: "No exportable wallet found" },
        { status: 404 }
      );
    }

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

    // Send to admin's email
    const userEmail = session.user.email;
    if (!userEmail) {
      return NextResponse.json(
        { error: "No email address on your account" },
        { status: 400 }
      );
    }

    await sendEmail({
      to: userEmail,
      subject: "Private Key Export Verification - KeeperHub",
      text: `Your verification code to export the wallet private key is: ${code}\n\nThis code expires in ${CODE_EXPIRY_MINUTES} minutes.\n\nIf you did not request this, please ignore this email.`,
      html: `
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a2e;">Private Key Export Verification</h2>
  <p>Your verification code is:</p>
  <div style="text-align: center; margin: 24px 0;">
    <div style="display: inline-block; background: #f5f5f5; padding: 16px 32px; border-radius: 8px; font-size: 28px; font-weight: bold; letter-spacing: 6px; font-family: monospace; color: #1a1a2e;">${code}</div>
  </div>
  <p style="color: #666; font-size: 13px;">This code expires in ${CODE_EXPIRY_MINUTES} minutes. If you did not request this, please ignore this email.</p>
</div>`.trim(),
    });

    return NextResponse.json({ sent: true });
  } catch (error) {
    return apiError(error, "Failed to send export verification code");
  }
}
