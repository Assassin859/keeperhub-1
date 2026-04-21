import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import {
  isSafeSupportedChain,
  SUPPORTED_SAFE_CHAIN_IDS,
} from "@/lib/safe/contracts";
import { deployOrgSafe, listOrgSafes } from "@/lib/safe/deployment";

type AdminValidationSuccess = {
  organizationId: string;
};

type AdminValidationFailure = {
  error: string;
  status: number;
};

async function validateAdmin(
  request: Request
): Promise<AdminValidationSuccess | AdminValidationFailure> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const activeOrgId = getActiveOrgId(session);
  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });
  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can deploy Safe wallets",
      status: 403,
    };
  }

  return { organizationId: activeOrgId };
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await resolveOrganizationId(request);
    if ("error" in ctx) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    const rows = await listOrgSafes(ctx.organizationId);
    const safes = rows.map((row) => ({
      id: row.id,
      chainId: row.chainId,
      safeAddress: row.safeAddress,
      owners: row.owners,
      threshold: row.threshold,
      safeVersion: row.safeVersion,
      deploymentTxHash: row.deploymentTxHash,
      deploymentBlock: row.deploymentBlock,
      status: row.status,
      deployedAt: row.deployedAt,
      isSigningActive: row.isSigningActive,
      createdAt: row.createdAt,
    }));

    return NextResponse.json({
      safes,
      supportedChainIds: [...SUPPORTED_SAFE_CHAIN_IDS],
    });
  } catch (error) {
    return apiError(error, "Failed to list Safe wallets");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const admin = await validateAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const body: { chainId?: number } = await request.json();
    const chainId = body.chainId;

    if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
      return NextResponse.json(
        { error: "chainId is required and must be an integer" },
        { status: 400 }
      );
    }

    if (!isSafeSupportedChain(chainId)) {
      return NextResponse.json(
        {
          error: `Chain ${chainId} is not supported for Safe deployment`,
          supportedChainIds: [...SUPPORTED_SAFE_CHAIN_IDS],
        },
        { status: 400 }
      );
    }

    const result = await deployOrgSafe({
      organizationId: admin.organizationId,
      chainId,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Deploy endpoint failed for org=${admin.organizationId}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe",
          component: "safe-deploy-api",
          chain_id: chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      alreadyDeployed: result.alreadyDeployed,
      safe: {
        id: result.safe.id,
        chainId: result.safe.chainId,
        safeAddress: result.safe.safeAddress,
        owners: result.safe.owners,
        threshold: result.safe.threshold,
        safeVersion: result.safe.safeVersion,
        deploymentTxHash: result.safe.deploymentTxHash,
        deploymentBlock: result.safe.deploymentBlock,
        status: result.safe.status,
        deployedAt: result.safe.deployedAt,
        isSigningActive: result.safe.isSigningActive,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to deploy Safe wallet");
  }
}
