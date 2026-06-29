import "server-only";

import type {
  AdapterCallDescriptor,
  MulticallResult,
  ProtocolPosition,
} from "@/lib/scan/types";

/**
 * Build Multicall3 aggregate3 call descriptors for Sky savings balances.
 *
 * Encodes two independent reads against the sUSDS ERC-4626 vault:
 *   [0] balanceOf(account)   -> shares balance (for displayed amount)
 *   [1] maxWithdraw(account) -> USDS underlying (for USD pricing in scanOneChain)
 *
 * Returns an empty array when the chain has no registered SKY_SAVINGS entry.
 *
 * Implementation: see plan 56-02 (GREEN).
 */
export function buildSkyCalls(
  _userAddress: string,
  _chainId: number
): AdapterCallDescriptor[] {
  throw new Error("not implemented — see plan 56-02");
}

/**
 * Decode aggregate3 results for Sky savings balances.
 *
 * Returns a single ProtocolPosition with protocol "sky", healthFactor null,
 * noActiveLoan true, and suppliedAssets[0] = { symbol: "sUSDS", amount: shares,
 * decimals: 18, usdValue: null }. usdValue is filled by scanOneChain after
 * pricing via resolveUsdPrice (USDS -> DefiLlama fallback).
 *
 * Returns an empty array when balanceOf is zero or the call failed (soft-miss).
 *
 * Implementation: see plan 56-02 (GREEN).
 */
export function decodeSkyResults(
  _results: MulticallResult[],
  _address: string,
  _chainId: number
): ProtocolPosition[] {
  throw new Error("not implemented — see plan 56-02");
}
