import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { revokeRoleTokenAllowance } from "@/lib/safe/roles-orchestrator";

type RouteParams = {
  params: Promise<{ safeId: string; tokenAddress: string }>;
};

export async function DELETE(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { safeId, tokenAddress } = await params;
    if (!ethers.isAddress(tokenAddress)) {
      return NextResponse.json(
        { error: `Invalid token address: ${tokenAddress}` },
        { status: 400 }
      );
    }

    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const safe = await getSafeForOrg({
      safeId,
      organizationId: admin.organizationId,
    });
    if (!safe) {
      return NextResponse.json({ error: "Safe not found" }, { status: 404 });
    }

    const result = await revokeRoleTokenAllowance({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
      tokenAddress,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Revoke role allowance failed safe=${safe.id} token=${tokenAddress}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/role/allowances/[tokenAddress]",
          component: "safe-role-allowances-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      deleted: {
        id: result.deleted.id,
        tokenAddress: result.deleted.tokenAddress,
        tokenSymbol: result.deleted.tokenSymbol,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to revoke Safe role allowance");
  }
}
