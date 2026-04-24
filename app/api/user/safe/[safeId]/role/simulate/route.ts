import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { TEMPLATE_SPECS } from "@/lib/safe/condition-templates";
import { getNativeUsdPrice, weiToUsd } from "@/lib/safe/price-oracle";
import {
  PROTOCOL_CATALOG,
  type ProtocolSlug,
} from "@/lib/safe/protocol-registry";
import { getProtocolTargets } from "@/lib/safe/protocol-targets";
import {
  flattenInstallInput,
  type ProtocolInput,
} from "@/lib/safe/roles-orchestrator";

/**
 * Simulation endpoint used by the install / upgrade UI to show "you are about
 * to submit N transactions, roughly M gas, ~$X in fees".
 *
 * For a first-time install the Zodiac Roles proxy doesn't exist yet, so we
 * can't run estimateGas on the actual calldata. Instead we compute a
 * heuristic estimate from the operation mix: each sub-call within the
 * install MultiSend has a fairly tight gas distribution based on
 * operation type, and we err on the high side so the UI doesn't
 * under-promise.
 *
 * Returns a structured breakdown so the UI can render:
 *   - A list of "you will do X" lines (human-readable)
 *   - The raw gas units + priced estimate in native + USD
 *   - applied / skipped / conflictedTokens mirroring the install response
 */

const GAS_DEPLOY_MODULE = BigInt(350_000);
const GAS_ENABLE_MODULE = BigInt(55_000);
const GAS_ASSIGN_ROLES = BigInt(80_000);
const GAS_SET_DEFAULT_ROLE = BigInt(45_000);
const GAS_SCOPE_TARGET = BigInt(60_000);
const GAS_SCOPE_FUNCTION = BigInt(70_000);
const GAS_SET_ALLOWANCE = BigInt(75_000);
const GAS_OUTER_WRAPPER = BigInt(50_000);

type TokenLimitBody = {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  amountHuman?: string;
  periodSeconds?: number;
};

type SimulateBody = {
  protocols?: Array<
    | string
    | {
        slug?: string;
        tokens?: TokenLimitBody[];
      }
  >;
  allowedTokenSymbols?: string[];
  allowances?: Array<{
    tokenAddress?: string;
    maxRefillWei?: string;
    refillWei?: string;
    periodSeconds?: number;
  }>;
};

type OperationSummary = {
  label: string;
  detail: string;
  gasUnits: string;
};

/**
 * Accept both the new `{ protocols: ProtocolInput[] }` shape and the legacy
 * `{ protocols: string[], allowedTokenSymbols, allowances }` shape so the
 * simulate endpoint stays usable while the wizard UI is migrating.
 */
function normaliseBody(body: SimulateBody): {
  protocols: ProtocolInput[];
  skipped: string[];
} {
  const raw = body.protocols ?? [];
  const skipped: string[] = [];

  const looksLikeNewShape =
    raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null;

  if (looksLikeNewShape) {
    const protocols: ProtocolInput[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        continue;
      }
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
      protocols.push({ slug, tokens });
    }
    return { protocols, skipped };
  }

  const legacySlugs = raw.filter(
    (entry): entry is string => typeof entry === "string"
  );
  const legacySymbols = body.allowedTokenSymbols ?? [];
  const legacyAllowances = body.allowances ?? [];

  const tokens = legacyAllowances.flatMap((a) => {
    if (!(a.tokenAddress && a.maxRefillWei && a.periodSeconds)) {
      return [];
    }
    return [
      {
        tokenAddress: a.tokenAddress,
        tokenSymbol: legacySymbols[0] ?? "UNKNOWN",
        tokenDecimals: 18,
        amountHuman: a.maxRefillWei,
        periodSeconds: a.periodSeconds,
      },
    ];
  });

  const protocols: ProtocolInput[] = [];
  for (const slug of legacySlugs) {
    if (!(slug in PROTOCOL_CATALOG)) {
      skipped.push(slug);
      continue;
    }
    protocols.push({ slug, tokens });
  }
  return { protocols, skipped };
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
      return NextResponse.json({ error: "Safe not found" }, { status: 404 });
    }

    const body = (await request.json()) as SimulateBody;
    const { protocols: protocolInputs, skipped } = normaliseBody(body);

    let conflictedTokens: ReturnType<
      typeof flattenInstallInput
    >["conflictedTokens"] = [];
    let tokenAllowances: ReturnType<typeof flattenInstallInput>["allowances"] =
      [];
    try {
      const flattened = flattenInstallInput(protocolInputs);
      conflictedTokens = flattened.conflictedTokens;
      tokenAllowances = flattened.allowances;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid amount input" },
        { status: 400 }
      );
    }

    const operations: OperationSummary[] = [];
    let totalGas = BigInt(0);

    operations.push({
      label: "Deploy Zodiac Roles modifier",
      detail:
        "Deploys a fresh Roles proxy owned by the Safe via the canonical ModuleProxyFactory.",
      gasUnits: GAS_DEPLOY_MODULE.toString(),
    });
    totalGas += GAS_DEPLOY_MODULE;

    operations.push({
      label: "Enable module on Safe",
      detail:
        "safe.enableModule(rolesModifier) authorises the modifier to call execTransactionFromModule.",
      gasUnits: GAS_ENABLE_MODULE.toString(),
    });
    totalGas += GAS_ENABLE_MODULE;

    operations.push({
      label: "Assign automation role to Turnkey EOA",
      detail: "rolesModifier.assignRoles(delegate, [roleKey], [true])",
      gasUnits: GAS_ASSIGN_ROLES.toString(),
    });
    totalGas += GAS_ASSIGN_ROLES;

    operations.push({
      label: "Set default role for delegate",
      detail: "rolesModifier.setDefaultRole(delegate, roleKey)",
      gasUnits: GAS_SET_DEFAULT_ROLE.toString(),
    });
    totalGas += GAS_SET_DEFAULT_ROLE;

    const applied: string[] = [];
    let totalFunctionScopings = 0;
    let totalTargetScopings = 0;
    for (const p of protocolInputs) {
      const catalog = PROTOCOL_CATALOG[p.slug as ProtocolSlug];
      if (!catalog) {
        skipped.push(p.slug);
        continue;
      }
      const template = TEMPLATE_SPECS[catalog.templateSlug];
      if (!template) {
        skipped.push(p.slug);
        continue;
      }
      applied.push(p.slug);
      if (catalog.enforcementLevel === "target-only") {
        const targets = getProtocolTargets(
          p.slug as ProtocolSlug,
          safe.chainId
        );
        totalTargetScopings += targets.length;
      } else {
        const approxTargets = 2;
        const approxFunctionsPerTarget = 4;
        totalTargetScopings += approxTargets;
        totalFunctionScopings += approxTargets * approxFunctionsPerTarget;
      }
    }

    if (totalTargetScopings > 0 || totalFunctionScopings > 0) {
      const scopeDetail =
        totalFunctionScopings > 0
          ? `~${totalTargetScopings} target allowlistings + ~${totalFunctionScopings} function scopings with parameter conditions (recipient, token allowlist, amount within allowance).`
          : `~${totalTargetScopings} target-level allowlistings (no per-function conditions on these protocols).`;
      operations.push({
        label: `Scope ${applied.length} protocol${applied.length === 1 ? "" : "s"}`,
        detail: scopeDetail,
        gasUnits: (
          BigInt(totalTargetScopings) * GAS_SCOPE_TARGET +
          BigInt(totalFunctionScopings) * GAS_SCOPE_FUNCTION
        ).toString(),
      });
      totalGas +=
        BigInt(totalTargetScopings) * GAS_SCOPE_TARGET +
        BigInt(totalFunctionScopings) * GAS_SCOPE_FUNCTION;
    }

    if (tokenAllowances.length > 0) {
      operations.push({
        label: `Set ${tokenAllowances.length} token allowance${tokenAllowances.length === 1 ? "" : "s"}`,
        detail: tokenAllowances
          .map(
            (a) =>
              `${a.tokenSymbol} (${a.tokenAddress.slice(0, 6)}...${a.tokenAddress.slice(-4)}): cap ${a.maxRefillWei} wei every ${a.periodSeconds}s`
          )
          .join("; "),
        gasUnits: (
          BigInt(tokenAllowances.length) * GAS_SET_ALLOWANCE
        ).toString(),
      });
      totalGas += BigInt(tokenAllowances.length) * GAS_SET_ALLOWANCE;
    }

    totalGas += GAS_OUTER_WRAPPER;

    const [chainRow] = await db
      .select({ name: chains.name })
      .from(chains)
      .where(eq(chains.chainId, safe.chainId))
      .limit(1);

    let maxFeePerGasWei = BigInt(25_000_000_000);
    try {
      const rpcUrl = getRpcUrlByChainId(safe.chainId, "primary");
      const manager = await getRpcProviderFromUrls(
        rpcUrl,
        undefined,
        safe.chainId
      );
      const feeData = await manager.getProvider().getFeeData();
      if (feeData.maxFeePerGas) {
        maxFeePerGasWei = feeData.maxFeePerGas;
      } else if (feeData.gasPrice) {
        maxFeePerGasWei = feeData.gasPrice;
      }
    } catch {
      // use default
    }

    const totalCostWei = totalGas * maxFeePerGasWei;
    const totalCostNative = ethers.formatEther(totalCostWei);
    const [totalCostUsd, nativePriceUsd] = await Promise.all([
      weiToUsd({ chainId: safe.chainId, amountWei: totalCostWei }),
      getNativeUsdPrice(safe.chainId),
    ]);

    return NextResponse.json({
      safe: {
        id: safe.id,
        chainId: safe.chainId,
        chainName: chainRow?.name ?? `chain-${safe.chainId}`,
        safeAddress: safe.safeAddress,
      },
      plan: {
        operations,
        totalGasUnits: totalGas.toString(),
        maxFeePerGasWei: maxFeePerGasWei.toString(),
        totalCostWei: totalCostWei.toString(),
        totalCostNative,
        totalCostUsd,
        nativePriceUsd,
        note: "Estimate is heuristic (operation-count times typical cost per operation). Actual gas will vary by ~20%.",
      },
      applied,
      skipped,
      conflictedTokens,
      allowances: tokenAllowances.map((a) => ({
        tokenAddress: a.tokenAddress,
        tokenSymbol: a.tokenSymbol,
        tokenDecimals: a.tokenDecimals,
        maxRefillWei: a.maxRefillWei,
        refillWei: a.refillWei,
        periodSeconds: a.periodSeconds,
      })),
    });
  } catch (error) {
    return apiError(error, "Failed to simulate policy install");
  }
}
