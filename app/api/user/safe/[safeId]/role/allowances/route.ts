import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import {
  getSafeRole,
  listRoleAllowances,
  setRoleTokenAllowance,
} from "@/lib/safe/roles-orchestrator";

type RouteParams = { params: Promise<{ safeId: string }> };

type SetAllowanceBody = {
  tokenAddress?: string;
  maxRefillWei?: string;
  refillWei?: string;
  periodSeconds?: number;
  tokenSymbol?: string;
  tokenDecimals?: number;
};

export async function GET(
  request: Request,
  { params }: RouteParams
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
      return NextResponse.json({ error: "Safe not found" }, { status: 404 });
    }

    const role = await getSafeRole(safe.id);
    if (!role) {
      return NextResponse.json({ allowances: [] });
    }

    const rows = await listRoleAllowances(role.id);
    return NextResponse.json({
      allowances: rows.map((row) => ({
        id: row.id,
        allowanceKey: row.allowanceKey,
        tokenAddress: row.tokenAddress,
        tokenSymbol: row.tokenSymbol,
        tokenDecimals: row.tokenDecimals,
        maxRefillWei: row.maxRefillWei,
        refillWei: row.refillWei,
        periodSeconds: row.periodSeconds,
        lastChainBalanceWei: row.lastChainBalanceWei,
        lastChainTimestamp: row.lastChainTimestamp,
        lastReconciledAt: row.lastReconciledAt,
        lastUpdatedAt: row.lastUpdatedAt,
      })),
    });
  } catch (error) {
    return apiError(error, "Failed to list Safe role allowances");
  }
}

export async function POST(
  request: Request,
  { params }: RouteParams
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
      return NextResponse.json({ error: "Safe not found" }, { status: 404 });
    }

    const body = (await request.json()) as SetAllowanceBody;
    if (!(body.tokenAddress && ethers.isAddress(body.tokenAddress))) {
      return NextResponse.json(
        { error: "tokenAddress is required and must be a valid address" },
        { status: 400 }
      );
    }
    if (!body.maxRefillWei || typeof body.maxRefillWei !== "string") {
      return NextResponse.json(
        { error: "maxRefillWei is required (stringified uint128)" },
        { status: 400 }
      );
    }
    if (!body.refillWei || typeof body.refillWei !== "string") {
      return NextResponse.json(
        { error: "refillWei is required (stringified uint128)" },
        { status: 400 }
      );
    }
    if (
      typeof body.periodSeconds !== "number" ||
      !Number.isInteger(body.periodSeconds) ||
      body.periodSeconds < 0
    ) {
      return NextResponse.json(
        {
          error: "periodSeconds is required and must be a non-negative integer",
        },
        { status: 400 }
      );
    }

    const result = await setRoleTokenAllowance({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
      tokenAddress: body.tokenAddress,
      maxRefillWei: body.maxRefillWei,
      refillWei: body.refillWei,
      periodSeconds: body.periodSeconds,
      tokenSymbol: body.tokenSymbol,
      tokenDecimals: body.tokenDecimals,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Set role allowance failed safe=${safe.id} token=${body.tokenAddress}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/role/allowances",
          component: "safe-role-allowances-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      allowance: {
        id: result.allowance.id,
        allowanceKey: result.allowance.allowanceKey,
        tokenAddress: result.allowance.tokenAddress,
        tokenSymbol: result.allowance.tokenSymbol,
        tokenDecimals: result.allowance.tokenDecimals,
        maxRefillWei: result.allowance.maxRefillWei,
        refillWei: result.allowance.refillWei,
        periodSeconds: result.allowance.periodSeconds,
        lastAppliedTxHash: result.allowance.lastAppliedTxHash,
        lastUpdatedAt: result.allowance.lastUpdatedAt,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to set Safe role allowance");
  }
}
