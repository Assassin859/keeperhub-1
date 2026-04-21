import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getTokenInfo } from "@/lib/contracts/tokens";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import {
  getSafeInstallation,
  listSafeAllowancesWithChainState,
  setTokenAllowance,
} from "@/lib/safe/modules";

type SetAllowanceBody = {
  tokenAddress?: string;
  amountWei?: string;
  periodMinutes?: number;
  /**
   * Optional token metadata. Used only when the token is not in the server
   * registry (e.g., a custom ERC20 address from the admin UI); for known
   * tokens the server resolves these itself.
   */
  tokenSymbol?: string;
  tokenDecimals?: number;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ safeId: string }> }
): Promise<NextResponse> {
  try {
    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const { safeId } = await params;
    const safe = await getSafeForOrg({
      safeId,
      organizationId: admin.organizationId,
    });
    if (!safe) {
      return NextResponse.json(
        { error: "Safe not found for this organization" },
        { status: 404 }
      );
    }

    const [installation, enriched] = await Promise.all([
      getSafeInstallation(safe.id),
      listSafeAllowancesWithChainState({
        safeWalletId: safe.id,
        safeAddress: safe.safeAddress,
        chainId: safe.chainId,
      }),
    ]);

    return NextResponse.json({
      moduleInstalled: installation?.status === "enabled",
      moduleAddress: installation?.moduleAddress ?? null,
      limits: enriched.map(({ row, onChain }) => {
        // Token metadata in the DB row may be stale from an earlier write
        // when the token wasn't in the server-side registry (fallback:
        // UNKNOWN / decimals=18). Prefer fresh metadata when available so
        // the UI renders correct amounts for pre-existing rows.
        const fresh = getTokenInfo(safe.chainId, row.tokenAddress);
        const tokenSymbol = fresh?.symbol ?? row.tokenSymbol;
        const tokenDecimals = fresh?.decimals ?? row.tokenDecimals;
        return {
          id: row.id,
          delegateAddress: row.delegateAddress,
          tokenAddress: row.tokenAddress,
          tokenSymbol,
          tokenDecimals,
          // on-chain truth takes precedence over DB cache
          amountWei: onChain.amountWei,
          spentWei: onChain.spentWei,
          periodMinutes: onChain.resetTimeMinutes || row.periodMinutes,
          resetAt: onChain.resetAt,
          lastTxHash: row.lastTxHash,
          lastUpdatedAt: row.lastUpdatedAt,
          createdAt: row.createdAt,
        };
      }),
    });
  } catch (error) {
    return apiError(error, "Failed to list Safe spending limits");
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ safeId: string }> }
): Promise<NextResponse> {
  try {
    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const { safeId } = await params;
    const safe = await getSafeForOrg({
      safeId,
      organizationId: admin.organizationId,
    });
    if (!safe) {
      return NextResponse.json(
        { error: "Safe not found for this organization" },
        { status: 404 }
      );
    }

    const body = (await request.json()) as SetAllowanceBody;
    const tokenAddress = body.tokenAddress;
    const amountWei = body.amountWei;
    const periodMinutes = body.periodMinutes;

    if (!tokenAddress || typeof tokenAddress !== "string") {
      return NextResponse.json(
        { error: "tokenAddress is required" },
        { status: 400 }
      );
    }
    if (!amountWei || typeof amountWei !== "string") {
      return NextResponse.json(
        { error: "amountWei is required (string-encoded uint256)" },
        { status: 400 }
      );
    }
    if (
      typeof periodMinutes !== "number" ||
      !Number.isInteger(periodMinutes) ||
      periodMinutes < 0 ||
      periodMinutes > 0xff_ff
    ) {
      return NextResponse.json(
        {
          error: "periodMinutes is required and must be a uint16 integer",
        },
        { status: 400 }
      );
    }

    const result = await setTokenAllowance({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
      tokenAddress,
      amountWei,
      periodMinutes,
      tokenSymbol: body.tokenSymbol,
      tokenDecimals: body.tokenDecimals,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Set allowance endpoint failed for org=${admin.organizationId} safe=${safe.id} token=${tokenAddress}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/allowances",
          component: "safe-allowances-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      limit: {
        id: result.limit.id,
        delegateAddress: result.limit.delegateAddress,
        tokenAddress: result.limit.tokenAddress,
        tokenSymbol: result.limit.tokenSymbol,
        tokenDecimals: result.limit.tokenDecimals,
        amountWei: result.limit.amountWei,
        periodMinutes: result.limit.periodMinutes,
        lastTxHash: result.limit.lastTxHash,
        lastUpdatedAt: result.limit.lastUpdatedAt,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to set Safe spending limit");
  }
}
