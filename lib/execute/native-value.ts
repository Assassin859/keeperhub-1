import "server-only";

import { ethers } from "ethers";

export type ReservedValue =
  | { ok: true; valueWei: string }
  | { ok: false; error: string };

/**
 * Native notional value (in wei) an execution will move, used by the per-org
 * daily spending cap. Parses a human-decimal ETH amount (e.g. "1.5") the same
 * way the web3 cores do (`ethers.parseEther`).
 *
 * An absent/empty amount reserves "0". Only native value is counted today;
 * ERC-20 token amounts are not yet priced into the cap, so token-only transfers
 * pass "0" directly rather than calling this.
 *
 * Malformed amounts return `{ ok: false }` so the caller can decide (the direct
 * routes reject with 400; the workflow wrapper reserves 0 and lets the core's
 * own validation surface the canonical error). Negative amounts are rejected
 * too: `ethers.parseEther("-5")` yields a negative BigInt (it does not throw),
 * and a negative reservation would lower the day's SUM and bank credit against
 * the cap.
 */
export function parseNativeValueWei(
  rawAmount: string | undefined | null
): ReservedValue {
  if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
    return { ok: true, valueWei: "0" };
  }

  let parsed: bigint;
  try {
    parsed = ethers.parseEther(rawAmount);
  } catch {
    return { ok: false, error: `Invalid value amount: ${rawAmount}` };
  }

  if (parsed < BigInt(0)) {
    return {
      ok: false,
      error: `Value amount must not be negative: ${rawAmount}`,
    };
  }

  return { ok: true, valueWei: parsed.toString() };
}
