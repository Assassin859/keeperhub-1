import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { installAllowanceModule } from "@/lib/safe/modules";

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

    const result = await installAllowanceModule({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Install module endpoint failed for org=${admin.organizationId} safe=${safe.id}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/modules/allowance",
          component: "safe-modules-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      alreadyInstalled: result.alreadyInstalled,
      installation: {
        id: result.installation.id,
        safeWalletId: result.installation.safeWalletId,
        moduleType: result.installation.moduleType,
        moduleAddress: result.installation.moduleAddress,
        installedTxHash: result.installation.installedTxHash,
        installedAt: result.installation.installedAt,
        status: result.installation.status,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to install Allowance Module");
  }
}
