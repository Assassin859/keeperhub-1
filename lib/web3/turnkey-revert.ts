import "server-only";
import type { Hex } from "viem";

/**
 * Turnkey-supplied revert information for a sponsored transaction.
 *
 * Shape mirrors `v1RevertChainEntry` from @turnkey/sdk-server but is
 * redeclared here so the rest of the codebase doesn't have to import
 * the SDK's internal types.
 */
export type RevertChainEntry = {
  address?: string;
  errorType?: string;
  displayMessage?: string;
  native?: {
    nativeType?: string;
    message?: string;
  };
  custom?: {
    errorName?: string;
    paramsJson?: string;
  };
  unknown?: {
    selector?: string;
    data?: string;
  };
};

/**
 * Thrown when Turnkey reports that a sponsored transaction was broadcast
 * to the network and then reverted on-chain. The presence of `txHash`
 * means the transaction is already mined; callers MUST NOT fall back to
 * direct signing because the underlying call would just revert again.
 *
 * Pre-broadcast failures (policy denial, gas-cap exhaustion, simulation
 * errors) do NOT produce this error -- they yield `null` from the
 * sponsorship wrapper so callers can fall through to direct signing.
 */
export class SponsoredTxRevertError extends Error {
  readonly kind = "sponsored-tx-revert" as const;
  readonly txHash: Hex;
  readonly sendTransactionStatusId: string;
  readonly revertChain: readonly RevertChainEntry[];

  constructor(opts: {
    message: string;
    txHash: Hex;
    sendTransactionStatusId: string;
    revertChain: readonly RevertChainEntry[];
  }) {
    super(opts.message);
    this.name = "SponsoredTxRevertError";
    this.txHash = opts.txHash;
    this.sendTransactionStatusId = opts.sendTransactionStatusId;
    this.revertChain = opts.revertChain;
  }
}

export function isSponsoredTxRevertError(
  err: unknown
): err is SponsoredTxRevertError {
  return (
    err instanceof Error &&
    (err as { kind?: string }).kind === "sponsored-tx-revert"
  );
}

/**
 * Render a Turnkey revert chain into a single human-readable string.
 *
 * Walks the chain outermost-to-innermost (the order Turnkey returns).
 * For each entry, prefer the structured native/custom decoding over the
 * raw display message. Falls back to "execution reverted" if no entry
 * carries usable detail.
 */
export function formatRevertChain(chain: readonly RevertChainEntry[]): string {
  if (chain.length === 0) {
    return "execution reverted";
  }

  const lines: string[] = [];
  for (const entry of chain) {
    const detail = describeEntry(entry);
    const location = entry.address ? ` at ${entry.address}` : "";
    lines.push(`${detail}${location}`);
  }
  return lines.join(" -> ");
}

function describeEntry(entry: RevertChainEntry): string {
  if (entry.custom?.errorName) {
    const params = entry.custom.paramsJson
      ? `(${entry.custom.paramsJson})`
      : "()";
    return `${entry.custom.errorName}${params}`;
  }
  if (entry.native?.message) {
    return entry.native.message;
  }
  if (entry.native?.nativeType === "panic") {
    return "panic";
  }
  if (entry.unknown?.selector) {
    return `unknown error (selector ${entry.unknown.selector})`;
  }
  if (entry.displayMessage) {
    return entry.displayMessage;
  }
  return "execution reverted";
}
