import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { PROTOCOL_CATALOG } from "@/lib/safe/protocol-registry";
import {
  DIRECT_RULE_PROTOCOL_SLUG,
  revokeRoleTokenAllowance,
} from "@/lib/safe/roles-orchestrator";

// Slugs that may key an allowance bucket: any known protocol plus the
// synthetic "direct" slug used by per-rule (transfer/approve) caps.
const ALLOWED_ALLOWANCE_SLUGS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(PROTOCOL_CATALOG),
  DIRECT_RULE_PROTOCOL_SLUG,
]);

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

    const url = new URL(request.url);
    const protocolSlug = url.searchParams.get("protocolSlug");
    if (!protocolSlug) {
      return NextResponse.json(
        { error: "protocolSlug query parameter is required" },
        { status: 400 }
      );
    }
    if (!ALLOWED_ALLOWANCE_SLUGS.has(protocolSlug)) {
      return NextResponse.json(
        { error: `Unknown protocolSlug: ${protocolSlug}` },
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
      protocolSlug,
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
