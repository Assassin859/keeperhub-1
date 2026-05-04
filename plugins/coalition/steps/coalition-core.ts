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

/**
 * Whether a coalition write should attempt the gas-sponsored path.
 *
 * Sponsored execution routes through Pimlico bundlers, which do NOT relay
 * through Flashbots Protect or any chain's private mempool. Any action that
 * exposes `usePrivateMempool` must therefore skip sponsorship when the user
 * opts into private-mempool routing — otherwise the slash (or other
 * frontrunning-sensitive write) silently falls back to the public mempool
 * via the bundler, defeating the user's choice.
 *
 * Currently only `slash` exposes `usePrivateMempool`. If you add the option
 * to another action, route its sponsorship gate through this helper so the
 * constraint stays mechanical instead of relying on each call site to
 * remember it.
 *
 * See `lib/web3/steps/write-contract-core.ts` for the full rationale.
 */
export function shouldUseSponsorship(
  usePrivateMempool: boolean,
  isSponsorshipEnabled: boolean
): boolean {
  return !usePrivateMempool && isSponsorshipEnabled;
}

/**
 * Parse a single event from a transaction receipt's logs.
 * Returns the event args (typed via ethers.Result) or null if not found.
 */
export function parseCoalitionEvent(
  logs: readonly ethers.Log[],
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
