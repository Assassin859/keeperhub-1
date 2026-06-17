import "server-only";

import { and, eq, gt } from "drizzle-orm";
import {
  normalizeAddressForStorage,
  toChecksumAddress,
} from "@/lib/address-utils";
import { db } from "@/lib/db";
import { supportedTokens } from "@/lib/db/schema";
import { scanResults } from "@/lib/db/schema-scan";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { getEnabledChains } from "@/lib/rpc/chain-service";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import {
  buildAaveV3Calls,
  decodeAaveV3Results,
} from "@/lib/scan/adapters/aave-v3";
import { buildLidoCalls, decodeLidoResults } from "@/lib/scan/adapters/lido";
import {
  STABLECOIN_CHAINLINK_FEEDS,
  scannableChainIds,
} from "@/lib/scan/adapters/protocol-registry";
import {
  buildStablecoinCalls,
  decodeStablecoinResults,
  type StablecoinToken,
} from "@/lib/scan/adapters/stablecoins";
import { executeMulticallBatch } from "@/lib/scan/multicall-batch";
import { isDepegged, readChainlinkPrice } from "@/lib/scan/price/chainlink";
import { resolveUsdPrice } from "@/lib/scan/price/index";
import { scanChains } from "@/lib/scan/scan-chains";
import {
  type AdapterCallDescriptor,
  type ChainScanOutput,
  type MulticallResult,
  type ProtocolPosition,
  SCAN_SCHEMA_VERSION,
  type ScanResponse,
  type StablecoinBalance,
} from "@/lib/scan/types";
import { maybeZerionFallback } from "@/lib/scan/zerion-fallback";

/** Cache TTL in milliseconds — 5 minutes (SCAN-13). */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Internal: single-chain scan ─────────────────────────────────────────────

/**
 * Scan one EVM chain for the target address.
 *
 * Concatenates Aave V3, Lido, and stablecoin Multicall3 call descriptors into
 * a single `aggregate3.staticCall`, then decodes results per-adapter. Stablecoin
 * USD prices are resolved via Chainlink (when a feed is registered for the
 * chain) or DefiLlama HTTP fallback, and depeg status is flagged. Never throws —
 * let the `scanChains` fan-out caller handle errors (per-chain isolation).
 */
async function scanOneChain(
  chainId: number,
  userAddress: string
): Promise<ChainScanOutput> {
  const rpcManager = await getRpcProvider({ chainId });

  // Stablecoins registered for this chain (isStablecoin = true).
  const chainStablecoins: StablecoinToken[] = await db
    .select({
      tokenAddress: supportedTokens.tokenAddress,
      symbol: supportedTokens.symbol,
      decimals: supportedTokens.decimals,
    })
    .from(supportedTokens)
    .where(
      and(
        eq(supportedTokens.chainId, chainId),
        eq(supportedTokens.isStablecoin, true)
      )
    );

  // ── Build calls ─────────────────────────────────────────────────────────────
  const aaveCalls = buildAaveV3Calls(userAddress, chainId);
  const lidoCalls = buildLidoCalls(userAddress, chainId);
  const stablecoinCalls = buildStablecoinCalls(userAddress, chainStablecoins);

  // One Chainlink latestRoundData call per stablecoin that has a registered
  // feed on this chain. Track which stablecoin indices have feeds so results
  // can be paired back after decoding.
  const chainlinkCallDescriptors: AdapterCallDescriptor[] = [];
  const chainlinkFeedIndices: number[] = [];
  for (const [idx, token] of chainStablecoins.entries()) {
    const feedAddress = STABLECOIN_CHAINLINK_FEEDS[chainId]?.[token.symbol];
    if (feedAddress !== undefined) {
      chainlinkCallDescriptors.push(readChainlinkPrice(feedAddress));
      chainlinkFeedIndices.push(idx);
    }
  }

  const allCalls = [
    ...aaveCalls,
    ...lidoCalls,
    ...stablecoinCalls,
    ...chainlinkCallDescriptors,
  ];

  // If there's nothing to scan on this chain, return empty output immediately.
  if (allCalls.length === 0) {
    return { chainId, positions: [], stablecoins: [] };
  }

  const results: MulticallResult[] = await executeMulticallBatch(
    allCalls,
    rpcManager
  );

  // ── Slice results per adapter (must match build order above) ───────────────
  const aaveLen = aaveCalls.length;
  const lidoLen = lidoCalls.length;
  const stableLen = stablecoinCalls.length;

  const aaveResults = results.slice(0, aaveLen);
  const lidoResults = results.slice(aaveLen, aaveLen + lidoLen);
  const stablecoinResults = results.slice(
    aaveLen + lidoLen,
    aaveLen + lidoLen + stableLen
  );
  const chainlinkResults = results.slice(aaveLen + lidoLen + stableLen);

  // ── Decode positions ────────────────────────────────────────────────────────
  const positions: ProtocolPosition[] = [
    ...decodeAaveV3Results(aaveResults, userAddress, chainId),
    ...decodeLidoResults(lidoResults, userAddress, chainId),
  ];

  // ── Decode stablecoin balances + apply pricing ──────────────────────────────
  const rawStablecoins = decodeStablecoinResults(
    stablecoinResults,
    chainStablecoins,
    chainId
  );

  // Map stablecoin array index → its Chainlink result (when a feed was batched).
  const chainlinkByStableIdx = new Map<number, MulticallResult>();
  for (const [i, feedIdx] of chainlinkFeedIndices.entries()) {
    const clResult = chainlinkResults[i];
    if (clResult !== undefined) {
      chainlinkByStableIdx.set(feedIdx, clResult);
    }
  }

  const pricedStablecoins: StablecoinBalance[] = await Promise.all(
    rawStablecoins.map(async (stable) => {
      // Locate the original index of this token in chainStablecoins so we can
      // retrieve the Chainlink result that was paired to it above.
      const tokenIdx = chainStablecoins.findIndex(
        (t) =>
          t.tokenAddress === stable.tokenAddress && t.symbol === stable.symbol
      );
      const chainlinkResult =
        tokenIdx >= 0 ? chainlinkByStableIdx.get(tokenIdx) : undefined;

      const priceUsd = await resolveUsdPrice(
        chainId,
        stable.tokenAddress,
        stable.symbol,
        { chainlinkResult }
      );

      const depegged = priceUsd === null ? false : isDepegged(priceUsd);
      // Number precision loss acceptable for display value — raw amount preserved.
      const usdValue =
        priceUsd === null
          ? null
          : (Number(BigInt(stable.amount)) / 10 ** stable.decimals) * priceUsd;

      return {
        ...stable,
        priceUsd,
        depegged,
        usdValue,
      };
    })
  );

  return { chainId, positions, stablecoins: pricedStablecoins };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan an EVM address for DeFi positions across all registered chains.
 *
 * Cache short-circuit (SCAN-13): a fresh `scan_results` row (expiresAt > NOW)
 * returns the cached `ScanResponse` with zero RPC calls. On a cache miss,
 * all scannable chains are fanned out in parallel (4s per-chain timeout via
 * `scanChains`). Results are assembled into a `ScanResponse` with
 * `schemaVersion: 1`, written to the cache with a 5-minute TTL, and returned.
 *
 * Partial failure is a first-class state: chains that time out or error appear
 * in `unavailableChains[]`; healthy chains' positions are still returned.
 *
 * Zerion fallback (SCAN-12): `maybeZerionFallback` is called after native
 * scanning. In Phase 51 it always returns [] — native positions take precedence
 * for the same (protocol, chainId) pair when Phase 52 wires the real adapter.
 */
export async function scanAddress(rawAddress: string): Promise<ScanResponse> {
  const cacheKey = normalizeAddressForStorage(rawAddress);

  // 1. Cache short-circuit (SCAN-13): return instantly if a fresh row exists.
  const cached = await db
    .select()
    .from(scanResults)
    .where(
      and(
        eq(scanResults.address, cacheKey),
        gt(scanResults.expiresAt, new Date())
      )
    )
    .limit(1);

  if (cached[0] !== undefined) {
    getMetricsCollector().incrementCounter(MetricNames.SCAN_CACHE_HIT_TOTAL);
    return cached[0].resultJson;
  }

  getMetricsCollector().incrementCounter(MetricNames.SCAN_CACHE_MISS_TOTAL);

  // 2. Determine which chains to scan (intersection of enabled chains and
  //    chains that have at least one registered Aave V3 or Lido address).
  const enabledChains = await getEnabledChains();
  const enabledChainIds = enabledChains.map((c) => c.chainId);
  const chainIds = scannableChainIds(enabledChainIds);

  // 3. Fan out per-chain with 4s timeout isolation (SCAN-08).
  const { chainOutputs, unavailableChains } = await scanChains(
    chainIds,
    (chainId) => scanOneChain(chainId, rawAddress)
  );

  // 4. Zerion breadth fallback (SCAN-12, Phase 51: no-op stub).
  //    Native positions take precedence by (protocol, chainId).
  //    TODO(HARDEN-03): increment MetricNames.SCAN_ZERION_CALLS_TOTAL here
  //    when the real Zerion adapter is wired (stays 0 in v1.13 by design).
  const zerionPositions = await maybeZerionFallback(rawAddress, chainIds);
  const nativeKeys = new Set<string>(
    chainOutputs.flatMap((output) =>
      output.positions.map((p) => `${p.protocol}:${p.chainId}`)
    )
  );
  const mergedZerion = zerionPositions.filter(
    (p) => !nativeKeys.has(`${p.protocol}:${p.chainId}`)
  );

  // 5. Assemble ScanResponse.
  const positions: ProtocolPosition[] = [
    ...chainOutputs.flatMap((output) => output.positions),
    ...mergedZerion,
  ];
  const stablecoins: StablecoinBalance[] = chainOutputs.flatMap(
    (output) => output.stablecoins
  );

  const response: ScanResponse = {
    schemaVersion: SCAN_SCHEMA_VERSION,
    address: toChecksumAddress(rawAddress),
    positions,
    stablecoins,
    unavailableChains,
    scannedAt: new Date().toISOString(),
  };

  // 6. Write cache row with 5-min TTL (SCAN-13). Upsert on the unique address
  //    key so concurrent cache misses converge to one row rather than
  //    accumulating duplicates. A cache-write failure must never discard a
  //    successfully computed scan — swallow it and still return the result.
  try {
    const now = new Date();
    await db
      .insert(scanResults)
      .values({
        address: cacheKey,
        resultJson: response,
        scannedAt: now,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
      })
      .onConflictDoUpdate({
        target: scanResults.address,
        set: {
          resultJson: response,
          scannedAt: now,
          expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
        },
      });
  } catch {
    // Cache is best-effort; the scan already succeeded.
  }

  return response;
}
