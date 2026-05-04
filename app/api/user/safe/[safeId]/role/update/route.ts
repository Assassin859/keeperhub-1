import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { PROTOCOL_CATALOG } from "@/lib/safe/protocol-registry";
import {
  type DirectRuleInput,
  type ProtocolInput,
  updateRolesConfig,
} from "@/lib/safe/roles-orchestrator";

type RouteParams = { params: Promise<{ safeId: string }> };

type TokenLimitBody = {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  amountHuman?: string;
  periodSeconds?: number;
};

type DirectRuleBody = {
  kind?: "erc20-transfer" | "erc20-approve" | "native-transfer";
  tokenAddress?: string | null;
  tokenSymbol?: string;
  tokenDecimals?: number;
  counterparty?: string;
  amountHuman?: string;
  periodSeconds?: number;
};

type UpdateBody = {
  protocols?: Array<{
    slug?: string;
    tokens?: TokenLimitBody[];
  }>;
  directRules?: DirectRuleBody[];
};

function normaliseProtocols(body: UpdateBody): {
  protocols: ProtocolInput[];
  skipped: string[];
} {
  const skipped: string[] = [];
  const out: ProtocolInput[] = [];
  for (const entry of body.protocols ?? []) {
    const slug = entry?.slug;
    if (!slug) {
      continue;
    }
    if (!(slug in PROTOCOL_CATALOG)) {
      skipped.push(slug);
      continue;
    }
    const tokens = (entry.tokens ?? []).flatMap((t) => {
      if (
        !(t.tokenAddress && t.tokenSymbol) ||
        typeof t.tokenDecimals !== "number" ||
        !t.amountHuman ||
        typeof t.periodSeconds !== "number"
      ) {
        return [];
      }
      return [
        {
          tokenAddress: t.tokenAddress,
          tokenSymbol: t.tokenSymbol,
          tokenDecimals: t.tokenDecimals,
          amountHuman: t.amountHuman,
          periodSeconds: t.periodSeconds,
        },
      ];
    });
    out.push({ slug, tokens });
  }
  return { protocols: out, skipped };
}

function normaliseDirectRules(body: UpdateBody): DirectRuleInput[] {
  const out: DirectRuleInput[] = [];
  for (const rule of body.directRules ?? []) {
    if (
      !(rule.kind && rule.counterparty && rule.amountHuman && rule.tokenSymbol)
    ) {
      continue;
    }
    if (
      typeof rule.tokenDecimals !== "number" ||
      typeof rule.periodSeconds !== "number"
    ) {
      continue;
    }
    out.push({
      kind: rule.kind,
      tokenAddress: rule.tokenAddress ?? null,
      tokenSymbol: rule.tokenSymbol,
      tokenDecimals: rule.tokenDecimals,
      counterparty: rule.counterparty,
      amountHuman: rule.amountHuman,
      periodSeconds: rule.periodSeconds,
    });
  }
  return out;
}

/**
 * Apply a delta against an already-installed Zodiac Role. The body is the
 * FULL desired state (protocols + direct rules), not a patch -- the
 * orchestrator computes the diff internally so the client can just submit
 * "what the policies should look like now."
 *
 * Direct rule REMOVAL is not supported here in this revision; use the
 * per-allowance Revoke button for ERC-20 direct rule buckets.
 */
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
      return NextResponse.json(
        { error: "Safe not found for this organization" },
        { status: 404 }
      );
    }

    const body = (await request.json()) as UpdateBody;
    const { protocols, skipped } = normaliseProtocols(body);
    const directRules = normaliseDirectRules(body);

    const result = await updateRolesConfig({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
      protocols,
      directRules,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Roles update failed org=${admin.organizationId} safe=${safe.id}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/role/update",
          component: "safe-role-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      noChanges: result.noChanges,
      addedProtocols: result.addedProtocols,
      removedProtocols: result.removedProtocols,
      addedAllowances: result.addedAllowances,
      changedAllowances: result.changedAllowances,
      revokedAllowances: result.revokedAllowances,
      role: {
        id: result.role.id,
        rolesModifierAddress: result.role.rolesModifierAddress,
        status: result.role.status,
      },
      protocols: result.protocols.map((p) => ({
        id: p.id,
        protocolSlug: p.protocolSlug,
        status: p.status,
      })),
      allowances: result.allowances.map((a) => ({
        id: a.id,
        protocolSlug: a.protocolSlug,
        tokenAddress: a.tokenAddress,
        tokenSymbol: a.tokenSymbol,
        maxRefillWei: a.maxRefillWei,
        periodSeconds: a.periodSeconds,
      })),
      applied: result.applied,
      skipped: [...result.skipped, ...skipped],
    });
  } catch (error) {
    return apiError(error, "Failed to update Zodiac Roles configuration");
  }
}
