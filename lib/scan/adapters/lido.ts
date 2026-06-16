import "server-only";

import type {
  AdapterCallDescriptor,
  MulticallResult,
  ProtocolPosition,
} from "@/lib/scan/types";

// Stub — implementation added in GREEN phase.

export function buildLidoCalls(
  _userAddress: string,
  _chainId: number
): AdapterCallDescriptor[] {
  return [];
}

export function decodeLidoResults(
  _results: MulticallResult[],
  _address: string,
  _chainId: number
): ProtocolPosition[] {
  return [];
}
