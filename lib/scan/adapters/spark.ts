import "server-only";

import type {
  AdapterCallDescriptor,
  MulticallResult,
  ProtocolPosition,
} from "@/lib/scan/types";

/**
 * Build Multicall3 aggregate3 call descriptors for SparkLend position data.
 *
 * SparkLend is a direct Aave V3 fork — the Pool at SPARK_POOLS[chainId]
 * exposes the identical getUserAccountData + getUserEMode interface.
 *
 * Returns an empty array when the chain has no registered SparkLend Pool.
 *
 * Implementation: see plan 56-02 (GREEN).
 */
export function buildSparkCalls(
  _userAddress: string,
  _chainId: number
): AdapterCallDescriptor[] {
  throw new Error("not implemented — see plan 56-02");
}

/**
 * Decode aggregate3 results for SparkLend position data.
 *
 * Reuses the Aave V3 decode path (identical wire format) and remaps
 * `protocol` to "spark". Returns an empty array when no position exists.
 *
 * Implementation: see plan 56-02 (GREEN).
 */
export function decodeSparkResults(
  _results: MulticallResult[],
  _address: string,
  _chainId: number
): ProtocolPosition[] {
  throw new Error("not implemented — see plan 56-02");
}
