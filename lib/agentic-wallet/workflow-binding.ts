/**
 * Server-derived payTo + amount verification for /sign.
 *
 * Phase 37 fix #2: closes the HMAC-compromise drain by reading the
 * recipient and amount from the workflows registry instead of trusting
 * the caller-supplied paymentChallenge. The wallet client (v0.1.5+)
 * forwards the workflowSlug extracted from the x402 resource.url.
 *
 * Phase 37 fix-pack-2 R2: the binding is now chain-aware. Base (x402) still
 * requires caller payTo + amount to match the registry. Tempo (MPP) proofs
 * carry neither field -- they prove ownership of a sub-org wallet for a
 * challenge id, and settlement happens elsewhere -- so the tempo path looks
 * up the workflow + price (still required for the fix-pack-2 R1 daily-spend
 * deduction) but skips the caller-side equality checks. This closes the
 * regression that made every priced tempo workflow 403 with PAYTO_MISMATCH
 * after fix #2 landed.
 *
 * Fix-pack-3 N-1: the caller-supplied chain is cross-checked against the
 * workflow's registered chain. Without this, an attacker with a stolen HMAC
 * secret + a dual-chain victim (both walletAddressBase and walletAddressTempo
 * populated) could claim chain="tempo" on a Base-registered workflow to slip
 * past the Base-side payTo/amount equality checks and mint an MPP proof
 * against the victim's tempo wallet. Permissive on null workflow.chain to
 * avoid breaking legacy listings that pre-date the column; log a metric when
 * the column is populated so ops can track coverage.
 *
 * Fix-pack-4 (KEEP-391): the chain match is now performed on a normalised
 * tag so listings stored with a numeric chain id ("8453", "4217", "4218")
 * compare equal to the caller's slug form ("base", "tempo"). Before this
 * fix, a listing with chain="8453" rejected every legitimate Base-USDC
 * payment with CHAIN_MISMATCH because the wallet's payViaX402 always sends
 * chain="base". Unknown / unparseable wf.chain values are treated as a
 * mismatch (defensive) rather than null (permissive) so we never silently
 * widen access on an unrecognised tag.
 *
 * Lookup chain mirrors lib/x402/payment-gate.ts:resolveCreatorWallet.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationWallets, workflows } from "@/lib/db/schema";
import {
  BASE_CHAIN_ID,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_TESTNET_CHAIN_ID,
} from "./constants";

export type BindingFailure = {
  ok: false;
  status: number;
  code:
    | "WORKFLOW_SLUG_REQUIRED"
    | "UNKNOWN_WORKFLOW"
    | "WORKFLOW_NOT_PAYABLE"
    | "PAYTO_MISMATCH"
    | "AMOUNT_MISMATCH"
    | "CHAIN_MISMATCH";
  error: string;
};

export type BindingOk = {
  ok: true;
  expectedPayTo: string;
  expectedAmountMicro: string;
  workflowId: string;
};

export type BindingResult = BindingOk | BindingFailure;

export type BindingChain = "base" | "tempo";

const USDC_DECIMALS = 6;

const BASE_CHAIN_ID_STR = String(BASE_CHAIN_ID);
const TEMPO_MAINNET_CHAIN_ID_STR = String(TEMPO_MAINNET_CHAIN_ID);
const TEMPO_TESTNET_CHAIN_ID_STR = String(TEMPO_TESTNET_CHAIN_ID);

/**
 * Map any chain tag we accept on a workflow listing — slug ("base",
 * "tempo") or numeric chain id ("8453", "4217", "4218") — into the
 * canonical BindingChain form used by /sign callers. Returns null for
 * unrecognised values so the caller can decide whether null means
 * "permissive legacy" (when wf.chain itself is null) or "defensive
 * mismatch" (when wf.chain is set but unparseable).
 *
 * Case-insensitive on slug input; whitespace-trimmed. Numeric forms
 * are matched as decimal strings against the canonical constants in
 * lib/agentic-wallet/constants.ts so a future chain-id rename only
 * has to be done in one place.
 */
function normaliseChainTag(
  value: string | null | undefined
): BindingChain | null {
  if (typeof value !== "string") {
    return null;
  }
  const v = value.trim().toLowerCase();
  if (v === "base" || v === BASE_CHAIN_ID_STR) {
    return "base";
  }
  if (
    v === "tempo" ||
    v === TEMPO_MAINNET_CHAIN_ID_STR ||
    v === TEMPO_TESTNET_CHAIN_ID_STR
  ) {
    return "tempo";
  }
  return null;
}

function priceToMicro(
  priceUsdcPerCall: string | null | undefined
): bigint | null {
  if (!priceUsdcPerCall) {
    return null;
  }
  const n = Number(priceUsdcPerCall);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

export async function verifyWorkflowBinding(
  slug: string | undefined | null,
  chain: BindingChain,
  payTo: string,
  amountMicro: string
): Promise<BindingResult> {
  if (!slug) {
    return {
      ok: false,
      status: 400,
      code: "WORKFLOW_SLUG_REQUIRED",
      error: "workflowSlug is required",
    };
  }

  const rows = await db
    .select({
      id: workflows.id,
      organizationId: workflows.organizationId,
      priceUsdcPerCall: workflows.priceUsdcPerCall,
      chain: workflows.chain,
    })
    .from(workflows)
    .where(and(eq(workflows.listedSlug, slug), eq(workflows.isListed, true)))
    .limit(1);

  const wf = rows[0];
  if (!wf) {
    return {
      ok: false,
      status: 403,
      code: "UNKNOWN_WORKFLOW",
      error: "Workflow not found or not listed",
    };
  }

  // Fix-pack-3 N-1 + Fix-pack-4 (KEEP-391): reject requests whose
  // caller-supplied chain does not match the workflow's registered chain,
  // comparing on a normalised tag so listings stored with a numeric chain
  // id ("8453", "4217", "4218") compare equal to the slug forms ("base",
  // "tempo"). Null is permissive for legacy listings that pre-date the
  // workflows.chain column. Unknown / unparseable values are treated as a
  // mismatch (defensive) rather than null (permissive) so we never silently
  // widen access on an unrecognised tag.
  if (wf.chain) {
    const wfNorm = normaliseChainTag(wf.chain);
    if (wfNorm === null || wfNorm !== chain) {
      return {
        ok: false,
        status: 403,
        code: "CHAIN_MISMATCH",
        error: "chain does not match workflow's registered chain",
      };
    }
  }

  const orgId = wf.organizationId;
  if (!orgId) {
    return {
      ok: false,
      status: 403,
      code: "WORKFLOW_NOT_PAYABLE",
      error: "Workflow has no organization",
    };
  }

  const walletRows = await db
    .select({ walletAddress: organizationWallets.walletAddress })
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, orgId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);
  const expectedPayTo = walletRows[0]?.walletAddress;

  const expectedMicro = priceToMicro(wf.priceUsdcPerCall);
  if (!expectedPayTo || expectedMicro === null) {
    return {
      ok: false,
      status: 403,
      code: "WORKFLOW_NOT_PAYABLE",
      error: "Workflow has no active wallet or price",
    };
  }

  if (chain === "base") {
    if (payTo.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return {
        ok: false,
        status: 403,
        code: "PAYTO_MISMATCH",
        error: "payTo does not match workflow creator wallet",
      };
    }

    let actualMicro: bigint;
    try {
      actualMicro = BigInt(amountMicro);
    } catch {
      return {
        ok: false,
        status: 403,
        code: "AMOUNT_MISMATCH",
        error: "amount is not a valid integer",
      };
    }
    if (actualMicro !== expectedMicro) {
      return {
        ok: false,
        status: 403,
        code: "AMOUNT_MISMATCH",
        error: "amount does not match workflow priceUsdcPerCall",
      };
    }
  }

  return {
    ok: true,
    expectedPayTo,
    expectedAmountMicro: expectedMicro.toString(),
    workflowId: wf.id,
  };
}
