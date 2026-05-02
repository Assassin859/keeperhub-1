import "server-only";

import { ethers } from "ethers";
import { COALITION_ABI } from "../contracts/coalition-abi";
import { COALITION_ADDRESSES, SUPPORTED_CHAIN_IDS } from "../contracts/addresses";

export const STATE_LABELS = [
  "NONE",
  "PROPOSED",
  "ACTIVE",
  "DISSOLVED",
  "SLASHED",
  "EXPIRED",
] as const;

export type CoalitionState = (typeof STATE_LABELS)[number];

export function stateLabel(stateUint: number | bigint): CoalitionState {
  const idx = Number(stateUint);
  return STATE_LABELS[idx] ?? "NONE";
}

export function getCoalitionAddress(chainId: number): `0x${string}` {
  const addr = COALITION_ADDRESSES[chainId];
  if (!addr) {
    const supported = SUPPORTED_CHAIN_IDS.join(", ");
    throw new Error(
      `Coalition contract is not deployed on chain ${chainId}. Supported chains: ${supported}.`
    );
  }
  return addr;
}

// One Interface instance for revert decoding across all coalition steps.
export const coalitionInterface = new ethers.Interface(
  COALITION_ABI as unknown as ethers.InterfaceAbi
);

type MinimalLog = {
  topics: readonly string[];
  data: string;
};

/**
 * Parse a single event from a transaction receipt's logs.
 * Accepts the minimal log shape (topics + data) so it works with both
 * full ethers.Log objects and the stripped ReceiptWithLogs type used in
 * propose-core and other write steps.
 * Returns the event args (typed via ethers.Result) or null if not found.
 */
export function parseCoalitionEvent(
  logs: readonly MinimalLog[],
  eventName: string
): ethers.Result | null {
  for (const log of logs) {
    try {
      const parsed = coalitionInterface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed?.name === eventName) {
        return parsed.args;
      }
    } catch {
      // Not a coalition log; skip
    }
  }
  return null;
}
