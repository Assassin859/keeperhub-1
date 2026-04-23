import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  normalizeAddressForStorage,
  truncateAddress,
} from "@/lib/address-utils";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createIntegration } from "@/lib/db/integrations";
import { integrations, organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { createTurnkeyWallet } from "@/lib/turnkey/turnkey-client";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Helper: Validate user authentication, organization membership, and admin permissions
async function validateUserAndOrganization(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const user = session.user;

  if (!user.email) {
    return { error: "Email required to create wallet", status: 400 };
  }

  // Check if user is anonymous
  if (
    user.email.includes("@http://") ||
    user.email.includes("@https://") ||
    user.email.startsWith("temp-")
  ) {
    return {
      error:
        "Anonymous users cannot create wallets. Please sign in with a real account.",
      status: 400,
    };
  }

  // Get active organization from session
  const activeOrgId = getActiveOrgId(session);

  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  // Get user's member record in the active organization
  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });

  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  // Check if user has admin or owner role
  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can manage wallets",
      status: 403,
    };
  }

  return { user, organizationId: activeOrgId, member: activeMember };
}

// Helper: Check if a wallet already exists for this organization (one wallet per org at creation time;
// Para → Turnkey dual state is only reached via the provisioning script, not via this endpoint).
async function checkExistingWallet(
  organizationId: string
): Promise<{ error: string; status: number } | { valid: true }> {
  const existing = await db
    .select({ id: organizationWallets.id })
    .from(organizationWallets)
    .where(eq(organizationWallets.organizationId, organizationId))
    .limit(1);

  if (existing.length > 0) {
    return {
      error: "A wallet already exists for this organization",
      status: 400,
    };
  }

  return { valid: true };
}

// Helper: Get user-friendly error response for wallet creation failures
function getErrorResponse(error: unknown): NextResponse {
  // Catch DB unique constraint violation (race condition: wallet already exists)
  if (error instanceof Error) {
    const cause = error.cause;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "23505"
    ) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Wallet] Race condition: external wallet created but DB insert hit unique constraint",
        error,
        { endpoint: "/api/user/wallet", operation: "post" }
      );
      return NextResponse.json(
        { error: "A wallet already exists for this organization" },
        { status: 409 }
      );
    }
  }

  logSystemError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[Wallet] Creation failed",
    error,
    { endpoint: "/api/user/wallet", operation: "post" }
  );

  let errorMessage = "Failed to create wallet";
  let statusCode = 500;

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes("already exists")) {
      errorMessage = "A wallet already exists for this email address";
      statusCode = 409;
    } else if (message.includes("invalid email")) {
      errorMessage = "Invalid email format";
      statusCode = 400;
    } else if (message.includes("forbidden") || message.includes("403")) {
      errorMessage = "API key authentication failed. Please contact support.";
      statusCode = 403;
    } else {
      errorMessage = error.message;
    }
  }

  return NextResponse.json({ error: errorMessage }, { status: statusCode });
}

async function storeTurnkeyWalletAndIntegration(options: {
  userId: string;
  organizationId: string;
  email: string;
  walletAddress: string;
  turnkeySubOrgId: string;
  turnkeyWalletId: string;
  turnkeyPrivateKeyId: string;
}): Promise<{ walletAddress: string; walletId: string }> {
  const {
    userId,
    organizationId,
    email,
    walletAddress,
    turnkeySubOrgId,
    turnkeyWalletId,
    turnkeyPrivateKeyId,
  } = options;

  const normalizedWalletAddress = normalizeAddressForStorage(walletAddress);

  await db.insert(organizationWallets).values({
    userId,
    organizationId,
    provider: "turnkey",
    email,
    walletAddress: normalizedWalletAddress,
    turnkeySubOrgId,
    turnkeyWalletId,
    turnkeyPrivateKeyId,
  });

  const truncatedAddress = truncateAddress(normalizedWalletAddress);
  await createIntegration({
    userId,
    organizationId,
    name: truncatedAddress,
    type: "web3",
    config: {},
  });

  return { walletAddress: normalizedWalletAddress, walletId: turnkeyWalletId };
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
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

    const userId = session.user.id;

    const allWallets = await db
      .select()
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, activeOrgId));

    if (allWallets.length === 0) {
      return NextResponse.json({
        hasWallet: false,
        wallets: [],
        message: "No wallet found for this organization",
      });
    }

    const PROVIDER_ORDER: Record<"para" | "turnkey", number> = {
      para: 0,
      turnkey: 1,
    } as const;
    const wallets = allWallets
      .map((w) => ({
        id: w.id,
        provider: w.provider,
        canExportKey: w.provider === "turnkey",
        // Only the wallet creator may export its key, regardless of org role.
        isOwner: w.userId === userId,
        walletAddress: w.walletAddress,
        walletId: w.paraWalletId ?? w.turnkeyWalletId,
        email: w.email,
        createdAt: w.createdAt,
        organizationId: w.organizationId,
        isActive: w.isActive,
      }))
      .sort((a, b) => PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider]);

    const primary = wallets.find((w) => w.isActive) ?? wallets[0];

    return NextResponse.json({
      hasWallet: true,
      ...primary,
      wallets,
    });
  } catch (error) {
    return apiError(error, "Failed to get wallet");
  }
}

export async function POST(request: Request) {
  try {
    // 1. Validate user, organization, and admin permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { user, organizationId } = validation;

    const body: { email?: string } = await request.json();
    const walletEmail = body.email;

    if (!walletEmail || typeof walletEmail !== "string") {
      return NextResponse.json(
        { error: "Email is required to create a wallet" },
        { status: 400 }
      );
    }

    if (!EMAIL_REGEX.test(walletEmail)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    const existingCheck = await checkExistingWallet(organizationId);
    if ("error" in existingCheck) {
      return NextResponse.json(
        { error: existingCheck.error },
        { status: existingCheck.status }
      );
    }

    const orgName = `org-${organizationId.slice(0, 8)}`;
    const turnkeyResult = await createTurnkeyWallet(walletEmail, orgName);

    const { walletAddress: storedAddress, walletId } =
      await storeTurnkeyWalletAndIntegration({
        userId: user.id,
        organizationId,
        email: walletEmail,
        walletAddress: turnkeyResult.walletAddress,
        turnkeySubOrgId: turnkeyResult.subOrgId,
        turnkeyWalletId: turnkeyResult.walletId,
        turnkeyPrivateKeyId: turnkeyResult.privateKeyId,
      });

    return NextResponse.json({
      success: true,
      wallet: {
        address: storedAddress,
        walletId,
        email: walletEmail,
        organizationId,
        provider: "turnkey",
      },
    });
  } catch (error) {
    return getErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    // 1. Validate user, organization, and admin permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { organizationId } = validation;

    // 2. Delete only the active wallet for this organization.
    // During Para → Turnkey migration both wallets may coexist; the inactive
    // Para row must be removed via a dedicated admin flow (follow-up ticket).
    const deletedWallet = await db
      .delete(organizationWallets)
      .where(
        and(
          eq(organizationWallets.organizationId, organizationId),
          eq(organizationWallets.isActive, true)
        )
      )
      .returning();

    if (deletedWallet.length === 0) {
      return NextResponse.json(
        { error: "No wallet found to delete" },
        { status: 404 }
      );
    }

    // 3. Delete associated Web3 integration record only if no wallet remains
    const remaining = await db
      .select({ id: organizationWallets.id })
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, organizationId))
      .limit(1);

    if (remaining.length === 0) {
      await db
        .delete(integrations)
        .where(
          and(
            eq(integrations.organizationId, organizationId),
            eq(integrations.type, "web3")
          )
        );
    }

    return NextResponse.json({
      success: true,
      message: "Wallet deleted successfully",
    });
  } catch (error) {
    return apiError(error, "Failed to delete wallet");
  }
}
