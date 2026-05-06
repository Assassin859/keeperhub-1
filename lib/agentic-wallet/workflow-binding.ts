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
 * Fix-pack-5 (KEEP-432): the chain field on a listing is overloaded — for
 * Base-data workflows the data chain and the payment chain happen to be the
 * same ("base"/"8453"), so the registered chain doubles as the payment-chain
 * pin. For workflows whose data chain is *not* a payment chain (Ethereum,
 * Optimism, Polygon, Arbitrum), the listing's chain identifies WHERE THE
 * CONTRACTS LIVE, not which chain payment must arrive on. Such listings now
 * accept either Base x402 or Tempo MPP. The defensive-mismatch behaviour for
 * unknown / unparseable tags is preserved — only the explicitly whitelisted
 * data-chain ids in `KNOWN_DATA_CHAIN_IDS` widen the payment side.
 *
 * Security: even on data-chain listings the binding still server-derives
 * payTo from the registry on the Base path, and the Tempo path still resolves
 * the workflow's price for the daily-spend deduction. The fix-pack-3 N-1
 * concern (dual-chain victim, attacker chooses weaker chain) is unchanged for
 * Base- and Tempo-pinned listings. For data-chain listings there is no
 * payment-chain preference inherent to the workflow, so the pin doesn't apply.
 *
 * Note on creator degree-of-freedom: workflows.chain is a free-form text
 * column written by the listing API (lib/mcp/listing.ts) without an input
 * allowlist. A creator can intentionally tag a Base-only workflow with
 * chain="1" to widen acceptance to either payment chain. This isn't a
 * security boundary violation — payTo is still server-derived from the
 * org's wallet so payers are paying the legit creator regardless — but it
 * does mean which payment chains a listing accepts is author-controlled,
 * not platform-enforced. Tighten at the listing API if that ever becomes
 * a policy concern.
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
 * Whitelisted data-chain ids — chains that KeeperHub workflows can READ from
 * but that are NOT payment chains. Listings with one of these chains accept
 * payment via either Base x402 or Tempo MPP. Mirrors the mainnet set declared
 * in lib/rpc/rpc-config.ts; extend by editing this set when adding support
 * for a new read-only chain.
 *
 * Decimal string form to match the format stored in workflows.chain.
 */
export const KNOWN_DATA_CHAIN_IDS = new Set<string>([
  "1", // Ethereum mainnet
  "42161", // Arbitrum One
  "43114", // Avalanche C-Chain
  "56", // BNB Chain
  "137", // Polygon
  "16661", // 0G Mainnet (Aristotle)
  "9745", // Plasma Mainnet
]);

type ChainClassification =
  | { readonly kind: "payment"; readonly chain: BindingChain }
  | { readonly kind: "data" }
  | { readonly kind: "unrecognised" };

/**
 * Classify a workflow.chain tag into one of three buckets:
 * - "payment": a recognised payment-chain slug or chain id; the listing is
 *   pinned to that payment chain and the caller must match.
 * - "data": a recognised data-chain id (Ethereum, OP, Polygon, Arbitrum); the
 *   listing's chain identifies where the contracts live, not which chain
 *   payment must arrive on. Either Base or Tempo payment is accepted.
 * - "unrecognised": a non-empty value we can't parse. Treated as defensive
 *   mismatch by the binding so a typo or future tag never silently widens
 *   access.
 *
 * Case-insensitive on slug input; whitespace-trimmed. Numeric forms match
 * the canonical constants in lib/agentic-wallet/constants.ts so a chain-id
 * rename only happens in one place.
 */
function classifyChainTag(
  value: string | null | undefined
): ChainClassification {
  if (typeof value !== "string") {
    return { kind: "unrecognised" };
  }
  const v = value.trim().toLowerCase();
  if (v === "base" || v === BASE_CHAIN_ID_STR) {
    return { kind: "payment", chain: "base" };
  }
  if (
    v === "tempo" ||
    v === TEMPO_MAINNET_CHAIN_ID_STR ||
    v === TEMPO_TESTNET_CHAIN_ID_STR
  ) {
    return { kind: "payment", chain: "tempo" };
  }
  if (KNOWN_DATA_CHAIN_IDS.has(v)) {
    return { kind: "data" };
  }
  return { kind: "unrecognised" };
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

  // Fix-pack-3 N-1 + Fix-pack-4 (KEEP-391) + Fix-pack-5 (KEEP-432): classify
  // the workflow's chain tag into payment / data / unrecognised. Payment-
  // chain listings stay pinned to that chain (the original cross-chain-proof
  // defence). Data-chain listings (Ethereum, Arbitrum, Polygon, BNB, Avalanche, 0G, Plasma) only
  // describe where the workflow READS contracts from — they have no inherent
  // payment-chain preference, so either Base x402 or Tempo MPP is accepted.
  // Unrecognised tags stay defensive (mismatch) so a typo never widens access.
  // A null wf.chain remains permissive for legacy listings that pre-date the
  // workflows.chain column.
  if (wf.chain) {
    const wfClass = classifyChainTag(wf.chain);
    const matched =
      wfClass.kind === "data" ||
      (wfClass.kind === "payment" && wfClass.chain === chain);
    if (!matched) {
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
