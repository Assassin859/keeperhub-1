/**
 * Deterministic scan suggestion engine (SUGGEST-01).
 *
 * Maps a Phase-51 ScanResponse to a ranked, capped, dust-filtered
 * SuggestionDescriptor[] covering four categories:
 *   - health  (SUGGEST-02): HF monitoring for Aave V3 lending positions
 *   - yield   (SUGGEST-03): idle stablecoin yield monitor (depeg-suppressed)
 *   - alert   (SUGGEST-04): price/balance threshold alert for supply-only positions
 *   - claim   (SUGGEST-05): staking reward reminder for Lido positions
 *
 * Descriptions reference actual scanned values (SUGGEST-06).
 * Every descriptor carries a required chainId (SUGGEST-08).
 * HF thresholds are clamped via ranking.ts (SUGGEST-09).
 * All descriptors carry a read/write label, a per-card risk note, and the
 * global disclaimer is re-exported for consumers (SUGGEST-10).
 *
 * Zero AI calls. Zero new npm packages. Pure TypeScript.
 */

import {
  clampHfThreshold,
  DUST_THRESHOLD_USD,
  hfThresholdRaw,
  rankAndFilter,
} from "@/lib/scan/suggestions/ranking";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type {
  ProtocolPosition,
  ScanResponse,
  StablecoinBalance,
} from "@/lib/scan/types";

// ---------------------------------------------------------------------------
// APY context types (YIELD-01..04)
// ---------------------------------------------------------------------------

/**
 * The best-available yield entry for a (symbol, chainId) pair.
 *
 * `destinationAddress` is the on-chain contract address from the protocol
 * registry, or null when the protocol is not yet in the registry (label-only).
 */
export type ApyEntry = {
  apy: number;
  projectLabel: string;
  destinationAddress: string | null;
};

/**
 * Pre-computed APY context passed from the scan route into `buildSuggestions`.
 *
 * Built by `buildApyContext` in `lib/scan/price/defillama-yields.ts` from the
 * pre-fetched DefiLlama yields snapshot. The engine calls `getBestYield` for
 * each stablecoin and uses the returned entry for APY-aware copy.
 *
 * When no entry is available (fetch failed, TVL too low, chain not supported)
 * `getBestYield` returns null and the engine degrades to generic copy (YIELD-03).
 */
export type ApyContext = {
  getBestYield(symbol: string, chainId: number): ApyEntry | null;
};

// Re-export so consumers can access the disclaimer without a separate import.
export { SUGGESTION_DISCLAIMER } from "@/lib/scan/suggestions/types";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const RISK_NOTE_READ_ONLY =
  "Read-only monitoring. This workflow does not make any transactions.";

/**
 * Protocols that behave like savings/staking products (no active loan, no HF).
 * These route to the `claim` builder instead of the `alert` builder when
 * healthFactor is null.
 */
const SAVINGS_PROTOCOLS = new Set(["lido", "sky"]);

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function protocolLabel(protocol: string): string {
  switch (protocol) {
    case "aave-v3":
      return "Aave V3";
    case "lido":
      return "Lido";
    case "spark":
      return "Spark";
    case "sky":
      return "Sky";
    default:
      return protocol;
  }
}

function chainLabel(chainId: number): string {
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 10:
      return "Optimism";
    case 42_161:
      return "Arbitrum";
    case 8453:
      return "Base";
    case 137:
      return "Polygon";
    default:
      return `Chain ${chainId}`;
  }
}

// ---------------------------------------------------------------------------
// Category builders
// ---------------------------------------------------------------------------

/**
 * SUGGEST-02 + 06 + 09: Health-factor monitoring for active lending positions.
 *
 * Produces a "health" descriptor referencing the protocol, chain, current HF,
 * and total debt in USD. The suggested alert threshold is clamped per SUGGEST-09
 * (floor 1.3, default 1.5 when HF has headroom).
 */
function buildHealthSuggestion(pos: ProtocolPosition): SuggestionDescriptor {
  const hf = pos.healthFactor as number; // null check performed by caller
  const threshold = clampHfThreshold(hf);
  const slug = `hf-monitor-${pos.protocol}-${pos.chainId}`;
  const debt = pos.totalDebtUsd ?? 0;
  const protName = protocolLabel(pos.protocol);
  const chain = chainLabel(pos.chainId);

  return {
    id: slug,
    name: `${protName} Health Factor Alert`,
    description:
      `Monitor your ${protName} health factor (currently ${hf.toFixed(2)}) ` +
      `on ${chain}. Alert when HF drops below ${threshold.toFixed(1)}. ` +
      `Total debt: $${Math.round(debt)}.`,
    category: "health",
    chainId: pos.chainId,
    readOrWrite: "read",
    confirmInputs: {
      walletAddress: "Your wallet address to monitor",
      // Pre-computed as a 1e18 base-unit string so the factory condition
      // rightOperand and the user-visible description use the same value.
      threshold: hfThresholdRaw(threshold),
    },
    riskNote: RISK_NOTE_READ_ONLY,
    protocol: pos.protocol,
    usdValue: pos.totalDebtUsd,
  };
}

/**
 * SUGGEST-03: Stablecoin idle-yield monitoring (read-only).
 *
 * Only called when stable.depegged === false (depeg suppression handled by caller).
 *
 * When `apyContext` returns a valid entry with apy > 0, emits APY-aware copy
 * naming the best venue and rate (YIELD-01/02). Otherwise degrades to generic
 * "idle yield opportunities" copy (YIELD-03). readOrWrite stays "read" in
 * every branch (YIELD-04).
 */
function buildYieldSuggestion(
  stable: StablecoinBalance,
  apyContext?: ApyContext | null
): SuggestionDescriptor {
  const slug = `stablecoin-yield-${stable.symbol.toLowerCase()}-${stable.chainId}`;
  const chain = chainLabel(stable.chainId);
  const bal = stable.usdValue ?? 0;
  const entry = apyContext?.getBestYield(stable.symbol, stable.chainId) ?? null;

  if (entry !== null && entry.apy > 0) {
    const apyStr = entry.apy.toFixed(1);
    const confirmInputs: Record<string, string> = {
      walletAddress: "Your wallet address to monitor",
      tokenAddress: stable.tokenAddress,
    };
    if (entry.destinationAddress !== null) {
      confirmInputs.destinationAddress = entry.destinationAddress;
    }
    return {
      id: slug,
      name: `${stable.symbol} Idle Yield — ${entry.projectLabel}`,
      description:
        `Monitor your ${stable.symbol} balance ($${Math.round(bal)}) on ${chain}. ` +
        `Earn ~${apyStr}% APY via ${entry.projectLabel}.`,
      category: "yield",
      chainId: stable.chainId,
      readOrWrite: "read",
      confirmInputs,
      riskNote: RISK_NOTE_READ_ONLY,
      usdValue: stable.usdValue,
    };
  }

  return {
    id: slug,
    name: `${stable.symbol} Idle Yield Monitor`,
    description:
      `Monitor your ${stable.symbol} balance ($${Math.round(bal)}) on ${chain} ` +
      "for idle yield opportunities.",
    category: "yield",
    chainId: stable.chainId,
    readOrWrite: "read",
    confirmInputs: {
      walletAddress: "Your wallet address to monitor",
      tokenAddress: stable.tokenAddress,
    },
    riskNote: RISK_NOTE_READ_ONLY,
    usdValue: stable.usdValue,
  };
}

/**
 * SUGGEST-04: Price/balance threshold alert for supply-only lending positions.
 *
 * Called for positions with healthFactor === null (no active loan) and
 * protocol not in SAVINGS_PROTOCOLS — i.e. users who have collateral deposited
 * without debt on a lending protocol (e.g. Aave, Spark).
 */
function buildAlertSuggestion(pos: ProtocolPosition): SuggestionDescriptor {
  const asset = pos.suppliedAssets[0];
  const symbol = asset?.symbol ?? "Token";
  const slug = `price-alert-${symbol.toLowerCase()}-${pos.chainId}`;
  const collat = pos.totalCollateralUsd ?? asset?.usdValue ?? 0;
  const protName = protocolLabel(pos.protocol);
  const chain = chainLabel(pos.chainId);

  return {
    id: slug,
    name: `${symbol} Price Alert on ${protName}`,
    description:
      `Alert when your ${symbol} collateral value changes on ${protName} (${chain}). ` +
      `Current value: $${Math.round(collat)}.`,
    category: "alert",
    chainId: pos.chainId,
    readOrWrite: "read",
    confirmInputs: {
      walletAddress: "Your wallet address to monitor",
      tokenAddress: "ERC20 token contract address to monitor",
      alertThreshold: "Balance threshold in token base units",
    },
    riskNote: RISK_NOTE_READ_ONLY,
    protocol: pos.protocol,
    usdValue: collat,
  };
}

/**
 * SUGGEST-05: Staking reward / claim reminder for savings-protocol positions.
 *
 * Called for all positions whose protocol is in SAVINGS_PROTOCOLS (Lido, Sky).
 * Sky gets savings-appropriate copy and prefills the actual sUSDS token address
 * from the position (sourced from suppliedAssets[0].tokenAddress set by the
 * Sky adapter — no server-only registry import required).
 */
function buildRewardSuggestion(pos: ProtocolPosition): SuggestionDescriptor {
  const slug = `reward-reminder-${pos.protocol}-${pos.chainId}`;
  const protName = protocolLabel(pos.protocol);
  const chain = chainLabel(pos.chainId);
  const bal = pos.suppliedAssets[0]?.usdValue ?? pos.totalCollateralUsd ?? 0;
  const isSky = pos.protocol === "sky";

  const name = isSky
    ? "Sky Savings Balance Monitor"
    : `${protName} Staking Reward Reminder`;
  const description = isSky
    ? `Monitor your Sky Savings (sUSDS) balance ($${Math.round(bal)}) on ${chain}.`
    : `Remind yourself to check ${protName} staking rewards on ${chain}. Staked balance: $${Math.round(bal)}.`;
  const stakingTokenAddress = isSky
    ? (pos.suppliedAssets[0]?.tokenAddress ?? "sUSDS token address")
    : "Staking token contract address (e.g. wstETH on Ethereum)";

  return {
    id: slug,
    name,
    description,
    category: "claim",
    chainId: pos.chainId,
    readOrWrite: "read",
    confirmInputs: {
      walletAddress: "Your wallet address to monitor",
      stakingTokenAddress,
    },
    riskNote: RISK_NOTE_READ_ONLY,
    protocol: pos.protocol,
    usdValue: bal,
  };
}

// ---------------------------------------------------------------------------
// Main engine export
// ---------------------------------------------------------------------------

/**
 * Map a scan result to a ranked, capped, dust-filtered SuggestionDescriptor[].
 *
 * Covers SUGGEST-01 through SUGGEST-10. Pure function; no I/O, no AI calls.
 * Produces at most MAX_SUGGESTIONS (7) descriptors ordered health > yield >
 * alert > claim, then USD value descending within each category.
 *
 * @param apyContext - Optional pre-fetched APY context (YIELD-01..04).
 *   When provided, yield suggestions use live APY copy for stablecoins with
 *   known yield venues. When absent or null, generic copy is used (YIELD-03
 *   degrade). Callers that omit this argument continue to work unchanged.
 */
export function buildSuggestions(
  scan: ScanResponse,
  apyContext?: ApyContext | null
): SuggestionDescriptor[] {
  const raw: SuggestionDescriptor[] = [];

  // SUGGEST-02: HF monitoring for lending positions with active loans.
  // SUGGEST-04: Price alert for supply-only positions (healthFactor null, not lido).
  for (const pos of scan.positions) {
    if (pos.healthFactor === null) {
      // Supply-only (no debt): alert path for lending-collateral protocols;
      // savings protocols (lido, sky) fall through to the claim loop below.
      if (!SAVINGS_PROTOCOLS.has(pos.protocol)) {
        const collat =
          pos.totalCollateralUsd ?? pos.suppliedAssets[0]?.usdValue ?? 0;
        if (collat >= DUST_THRESHOLD_USD) {
          raw.push(buildAlertSuggestion(pos));
        }
      }
      continue;
    }
    // Active loan: health monitoring if debt exceeds dust threshold.
    const debt = pos.totalDebtUsd ?? 0;
    if (debt < DUST_THRESHOLD_USD) {
      continue;
    }
    raw.push(buildHealthSuggestion(pos));
  }

  // SUGGEST-03: Stablecoin yield monitoring (depeg-suppressed, dust-filtered).
  for (const stable of scan.stablecoins) {
    if (stable.depegged) {
      continue; // SUGGEST-03 depeg suppression
    }
    if ((stable.usdValue ?? 0) < DUST_THRESHOLD_USD) {
      continue;
    }
    raw.push(buildYieldSuggestion(stable, apyContext));
  }

  // SUGGEST-05: Staking reward reminders for savings-protocol positions (Lido, Sky).
  for (const pos of scan.positions) {
    if (!SAVINGS_PROTOCOLS.has(pos.protocol)) {
      continue;
    }
    const bal = pos.suppliedAssets[0]?.usdValue ?? pos.totalCollateralUsd ?? 0;
    if (bal < DUST_THRESHOLD_USD) {
      continue;
    }
    raw.push(buildRewardSuggestion(pos));
  }

  // SUGGEST-01 + 07: Rank by category/USD and cap at MAX_SUGGESTIONS.
  return rankAndFilter(raw);
}
