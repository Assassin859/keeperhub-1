import crypto from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { toChecksumAddress } from "@/lib/address-utils";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { keyExportCodes, organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { exportTurnkeyPrivateKey } from "@/lib/turnkey/turnkey-client";
import { checkVerifyRateLimit } from "../_lib/rate-limit";

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

    const body: { code?: string } = await request.json();
    const { code } = body;

    if (!code || typeof code !== "string" || code.length !== 6) {
      return NextResponse.json(
        { error: "A valid 6-digit code is required" },
        { status: 400 }
      );
    }

    // Find valid (non-expired) code for this org
    const now = new Date();
    const storedCodes = await db
      .select()
      .from(keyExportCodes)
      .where(
        and(
          eq(keyExportCodes.organizationId, activeOrgId),
          gt(keyExportCodes.expiresAt, now)
        )
      )
      .limit(1);

    if (storedCodes.length === 0) {
      return NextResponse.json(
        {
          error: "No valid verification code found. Please request a new one.",
        },
        { status: 400 }
      );
    }

    const storedCode = storedCodes[0];

    const MAX_ATTEMPTS = 5;

    // Atomic increment-and-return: Postgres serialises per-row UPDATEs, so N
    // concurrent attempts each get a unique post-UPDATE value. Gating on the
    // returned counter (rather than the pre-read one) prevents concurrent
    // callers from all passing the lockout check with stale values.
    const [updated] = await db
      .update(keyExportCodes)
      .set({ attempts: sql`${keyExportCodes.attempts} + 1` })
      .where(eq(keyExportCodes.id, storedCode.id))
      .returning({ attempts: keyExportCodes.attempts });

    if (!updated || updated.attempts >= MAX_ATTEMPTS) {
      await db
        .delete(keyExportCodes)
        .where(eq(keyExportCodes.id, storedCode.id));
      return NextResponse.json(
        { error: "Too many attempts. Please request a new code." },
        { status: 429 }
      );
    }

    const providedHash = hashCode(code);
    const providedBuffer = Buffer.from(providedHash, "hex");
    const storedBuffer = Buffer.from(storedCode.codeHash, "hex");

    if (
      providedBuffer.length !== storedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, storedBuffer)
    ) {
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 400 }
      );
    }

    // Delete used code (single-use)
    await db.delete(keyExportCodes).where(eq(keyExportCodes.id, storedCode.id));

    // Fetch Turnkey wallet and export
    const wallets = await db
      .select()
      .from(organizationWallets)
      .where(
        and(
          eq(organizationWallets.organizationId, activeOrgId),
          eq(organizationWallets.provider, "turnkey")
        )
      )
      .limit(1);

    if (wallets.length === 0) {
      return NextResponse.json(
        { error: "No Turnkey wallet found" },
        { status: 404 }
      );
    }

    const wallet = wallets[0];

    // Export must be completed by the wallet creator, not just any org admin.
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
