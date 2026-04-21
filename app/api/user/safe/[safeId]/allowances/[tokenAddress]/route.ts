import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { revokeTokenAllowance } from "@/lib/safe/modules";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ safeId: string; tokenAddress: string }> }
): Promise<NextResponse> {
  try {
    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const { safeId, tokenAddress } = await params;
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

    const result = await revokeTokenAllowance({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
      tokenAddress,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Revoke allowance endpoint failed for org=${admin.organizationId} safe=${safe.id} token=${tokenAddress}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/allowances/[tokenAddress]",
          component: "safe-allowances-api",
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
    return apiError(error, "Failed to revoke Safe spending limit");
  }
}
