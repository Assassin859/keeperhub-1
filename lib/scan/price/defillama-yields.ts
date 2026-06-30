import "server-only";

import type { ApyContext, ApyEntry } from "@/lib/scan/suggestions/engine";
import type { StablecoinBalance } from "@/lib/scan/types";

// Re-export for consumers that import types from this module.
export type { ApyContext, ApyEntry };

/**
 * Chain name map for the DefiLlama yields API (`yields.llama.fi/pools`).
 *
 * IMPORTANT: these differ from DEFILLAMA_CHAIN_SLUGS (coins API uses lowercase;
 * the yields API uses title-case). Optimism is "OP Mainnet" in the yields API,
 * not "Optimism" — using the wrong value silently returns zero pools for
 * chainId 10 (Pitfall 1 in 57-RESEARCH).
 *
 * [VERIFIED: live yields.llama.fi/pools 2026-06-30]
 */
export const DEFILLAMA_YIELDS_CHAIN_SLUGS: Record<number, string> = {
  1: "Ethereum",
  10: "OP Mainnet",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
};

/**
 * A single pool record from the DefiLlama yields API (`yields.llama.fi/pools`).
 *
 * Key fields for filtering and ranking:
 *   - `pool`  — internal DefiLlama UUID, NOT a contract address.
 *   - `apy`   — total APY (apyBase + apyReward); always rank/display on this.
 *   - `underlyingTokens` — ERC-20 addresses; use for project-agnostic matching.
 *
 * [VERIFIED: live yields.llama.fi/pools 2026-06-30]
 */
export type DefillamaYieldsPool = {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  underlyingTokens: string[];
};

/**
 * Fetches all stablecoin yield pools from DefiLlama (`yields.llama.fi/pools`).
 *
 * Uses a module-level 15-minute in-process cache to avoid repeated ~4MB fetches.
 * Returns [] on any failure (timeout, non-ok response, parse error) — graceful
 * degrade so callers fall back to generic copy (YIELD-03).
 *
 * NOT YET IMPLEMENTED — stub for type-check compliance (57-01 RED wave).
 * Implementation lands in 57-02.
 */
export async function fetchDefillamaYieldPools(): Promise<
  DefillamaYieldsPool[]
> {
  throw new Error("not implemented: 57-02");
}

/**
 * Builds the ApyContext lookup object from a pre-fetched pool snapshot.
 *
 * Filters by chain, project allowlist, TVL >= $10M, apy > 0, and
 * underlying token address match. USDS is pinned to sky-lending SUSDS;
 * USDC/USDT are ranked by max APY with TVL tie-break.
 *
 * NOT YET IMPLEMENTED — stub for type-check compliance (57-01 RED wave).
 * Implementation lands in 57-02.
 */
export function buildApyContext(
  _pools: DefillamaYieldsPool[],
  _stablecoins: StablecoinBalance[]
): ApyContext {
  throw new Error("not implemented: 57-02");
}

/**
 * Returns a human-readable label for a DefiLlama project slug.
 *
 * Example: projectSlugToLabel("aave-v3", 42161) → "Aave V3 on Arbitrum"
 *          projectSlugToLabel("sky-lending", 1) → "Sky Savings (sUSDS)"
 *
 * NOT YET IMPLEMENTED — stub for type-check compliance (57-01 RED wave).
 * Implementation lands in 57-02.
 */
export function projectSlugToLabel(
  _slug: string,
  _chainId: number
): string {
  throw new Error("not implemented: 57-02");
}

/**
 * Resets the module-level APY pool cache.
 *
 * Exported for test isolation — call in beforeEach to prevent cache state
 * from leaking between test cases.
 *
 * NOT YET IMPLEMENTED — stub for type-check compliance (57-01 RED wave).
 * Implementation lands in 57-02.
 */
export function clearApyCache(): void {
  throw new Error("not implemented: 57-02");
}
