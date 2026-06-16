import "server-only";

import type { AdapterCallDescriptor, MulticallResult } from "@/lib/scan/types";
import type { StablecoinBalance } from "@/lib/scan/types";

// Stub — implementation added in GREEN phase.

export interface StablecoinToken {
  tokenAddress: string;
  symbol: string;
  decimals: number;
}

export function buildStablecoinCalls(
  _userAddress: string,
  _tokens: StablecoinToken[]
): AdapterCallDescriptor[] {
  return [];
}

export function decodeStablecoinResults(
  _results: MulticallResult[],
  _tokens: StablecoinToken[],
  _chainId: number
): StablecoinBalance[] {
  return [];
}
