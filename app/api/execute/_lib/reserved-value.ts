import "server-only";

import { ethers } from "ethers";

export type ReservedValue =
  | { ok: true; valueWei: string }
  | { ok: false; error: string };

/**
 * Native notional value (in wei) a direct execution will move, used by the
 * per-org daily spending cap. Parses a human-decimal ETH amount (e.g. "1.5")
 * the same way the web3 cores do (`ethers.parseEther`).
 *
 * An absent/empty amount reserves "0". Only native value is counted today;
 * ERC-20 token amounts are not yet priced into the cap, so token-only transfers
 * pass "0" directly rather than calling this.
 *
 * Malformed amounts return `{ ok: false }` so the caller can reject with 400
 * instead of silently under-reserving (which would weaken the cap). Negative
 * amounts are rejected too: `ethers.parseEther("-5")` yields a negative BigInt
 * (it does not throw), and a negative reservation would lower the day's SUM and
 * bank credit against the cap.
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

/**
 * Native value (wei) reserved for a generic node execution, keyed by the
 * resolved step function. Only actions that broadcast native ETH value are
 * charged against the cap: a native transfer (`amount`) or a contract write
 * that forwards value (`ethValue`). Token transfers/approvals and off-chain
 * steps move no native value and reserve "0".
 *
 * Keyed on the step function so a newly-added value-bearing action must opt in
 * here rather than silently reserving 0 (which would be a cap bypass).
 */
export function parseNodeNativeValueWei(
  stepFunction: string,
  config: Record<string, unknown>
): ReservedValue {
  let raw: string | undefined;
  if (stepFunction === "transferFundsStep") {
    raw = typeof config.amount === "string" ? config.amount : undefined;
  } else if (stepFunction === "writeContractStep") {
    raw = typeof config.ethValue === "string" ? config.ethValue : undefined;
  }
  return parseNativeValueWei(raw);
}
