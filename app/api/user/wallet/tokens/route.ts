import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { apiError } from "@/lib/api-error";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { db } from "@/lib/db";
import { chains, organizationTokens, supportedTokens } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { organizationHasWallet } from "@/lib/web3/wallet-helpers";

/**
 * GET /api/user/wallet/tokens
 *
 * Get all tracked tokens for the organization
 */
export async function GET(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId: activeOrgId } = authCtx;

    const tokens = await db
      .select()
      .from(organizationTokens)
      .where(eq(organizationTokens.organizationId, activeOrgId));

    return NextResponse.json({ tokens });
  } catch (error) {
    return apiError(error, "Failed to fetch tokens");
  }
}

/**
 * POST /api/user/wallet/tokens
 *
 * Add a new token to track for the organization.
 * Fetches token metadata from the contract.
 */
export async function POST(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId: activeOrgId } = authCtx;

    // Check if organization has a wallet
    const hasWallet = await organizationHasWallet(activeOrgId);
    if (!hasWallet) {
      return NextResponse.json(
        { error: "Organization must have a wallet to track tokens" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { chainId, tokenAddress } = body;

    if (!chainId || typeof chainId !== "number") {
      return NextResponse.json(
        { error: "chainId is required and must be a number" },
        { status: 400 }
      );
    }

    if (!tokenAddress) {
      return NextResponse.json(
        { error: "Token address is required" },
        { status: 400 }
      );
    }

    if (!ethers.isAddress(tokenAddress)) {
      return NextResponse.json(
        { error: "Invalid token address format" },
        { status: 400 }
      );
    }

    // Check if chain exists and is enabled
    const chain = await db
      .select()
      .from(chains)
      .where(and(eq(chains.chainId, chainId), eq(chains.isEnabled, true)))
      .limit(1);

    if (chain.length === 0) {
      return NextResponse.json(
        { error: "Chain not found or not enabled" },
        { status: 400 }
      );
    }

    const normalizedTokenAddress = normalizeAddressForStorage(tokenAddress);

    // Check if token is already tracked by the organization
    const existing = await db
      .select()
      .from(organizationTokens)
      .where(
        and(
          eq(organizationTokens.organizationId, activeOrgId),
          eq(organizationTokens.chainId, chainId),
          eq(organizationTokens.tokenAddress, normalizedTokenAddress)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        { error: `Token (${existing[0].symbol}) is already being tracked` },
        { status: 400 }
      );
    }

    // Check if token is a default supported token (KEEP-1303)
    const existingDefault = await db
      .select()
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, chainId),
          eq(supportedTokens.tokenAddress, normalizedTokenAddress)
        )
      )
      .limit(1);

    if (existingDefault.length > 0) {
      return NextResponse.json(
        {
          error: `Token (${existingDefault[0].symbol}) is already being tracked`,
        },
        { status: 400 }
      );
    }

    // Fetch token metadata from the contract with retry/failover
    const rpcManager = await getRpcProvider({ chainId });

    let symbol: string;
    let name: string;
    let decimals: number;

    try {
      [symbol, name, decimals] = await rpcManager.executeWithFailover(
        (provider) => {
          const contract = new ethers.Contract(
            tokenAddress,
            ERC20_ABI,
            provider
          );
          return Promise.all([
            contract.symbol() as Promise<string>,
            contract.name() as Promise<string>,
            contract.decimals().then((d: bigint) => Number(d)),
          ]);
        }
      );
    } catch (error) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Tokens] Failed to fetch token metadata",
        error,
        { endpoint: "/api/user/wallet/tokens", operation: "fetchTokenMetadata" }
      );
      return NextResponse.json(
        { error: "Failed to fetch token metadata. Is this a valid ERC20?" },
        { status: 400 }
      );
    }

    // Insert the token
    const [newToken] = await db
      .insert(organizationTokens)
      .values({
        organizationId: activeOrgId,
        chainId,
        tokenAddress: normalizedTokenAddress,
        symbol,
        name,
        decimals,
      })
      .returning();

    console.log(
      `[Tokens] Added token ${symbol} (${tokenAddress}) for org ${activeOrgId} on chain ${chainId}`
    );

    return NextResponse.json({ token: newToken });
  } catch (error) {
    return apiError(error, "Failed to add token");
  }
}

/**
 * DELETE /api/user/wallet/tokens
 *
 * Remove a tracked token. Expects { tokenId } in the body.
 */
export async function DELETE(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId: activeOrgId } = authCtx;

    const body = await request.json();
    const { tokenId } = body;

    if (!tokenId || typeof tokenId !== "string") {
      return NextResponse.json(
        { error: "tokenId is required" },
        { status: 400 }
      );
    }

    // Delete the token (only if it belongs to this organization)
    const deleted = await db
      .delete(organizationTokens)
      .where(
        and(
          eq(organizationTokens.id, tokenId),
          eq(organizationTokens.organizationId, activeOrgId)
        )
      )
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: "Token not found or not owned by this organization" },
        { status: 404 }
      );
    }

    console.log(
      `[Tokens] Removed token ${deleted[0].symbol} for org ${activeOrgId}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, "Failed to remove token");
  }
}
