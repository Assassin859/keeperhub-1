import "server-only";

import type {
  AdapterCallDescriptor,
  MulticallResult,
  ProtocolPosition,
} from "@/lib/scan/types";

/**
 * Stub — replaced in GREEN phase.
 * Satisfies TypeScript types for TDD RED commit.
 */
export function buildAaveV3Calls(
  _userAddress: string,
  _chainId: number
): AdapterCallDescriptor[] {
  return [];
}

export function decodeAaveV3Results(
  _results: MulticallResult[],
  _address: string,
  _chainId: number
): ProtocolPosition[] {
  return [];
}

export function normalizeHealthFactor(
  _rawHf: bigint,
  _totalDebtBase: bigint
): number | null {
  return null;
}
