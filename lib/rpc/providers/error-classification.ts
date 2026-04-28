import { type EthersError, isError } from "ethers";

/**
 * Ethers error codes that indicate a permanent failure -- retrying on the same
 * or a different provider will never succeed. These are re-thrown immediately,
 * bypassing both the retry loop and the failover logic.
 */
export const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "CALL_EXCEPTION", // contract revert, out-of-gas, function not found
  "INVALID_ARGUMENT", // bad parameter types/values
  "MISSING_ARGUMENT",
  "UNEXPECTED_ARGUMENT",
  "NUMERIC_FAULT", // overflow, division by zero
  // BAD_DATA intentionally omitted -- handled conditionally in
  // isNonRetryableError() because "missing response for request" is transient
  // while other BAD_DATA messages (malformed ABI decode) are permanent.
]);

/**
 * Determine whether an error is non-retryable (i.e. retrying on a different
 * RPC endpoint cannot fix the problem). Shared between the read-path failover
 * in RpcProviderManager and the write-path failover in submitAndConfirm.
 */
export function isNonRetryableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const ethersError = error as EthersError;
  // BAD_DATA is context-dependent: "missing response for request" is a
  // transient batch/RPC issue that succeeds on retry, while other BAD_DATA
  // messages (malformed ABI decode) are permanent and should not be retried.
  // Defense-in-depth: batchMaxCount:1 prevents most batch errors, but this
  // guard protects against edge cases and future changes.
  if (ethersError.code === "BAD_DATA") {
    const msg =
      ethersError.message ??
      ("shortMessage" in ethersError
        ? (ethersError as EthersError & { shortMessage: string }).shortMessage
        : "");
    return !msg.includes("missing response for request");
  }

  return NON_RETRYABLE_ERROR_CODES.has(ethersError.code as string);
}

/**
 * Type guard for 429 rate-limit responses. Used by RpcProviderManager to
 * extract Retry-After headers.
 */
export function isRateLimitError(error: unknown): boolean {
  return (
    isError(error, "SERVER_ERROR") &&
    (error as EthersError & { response?: { statusCode?: number } }).response
      ?.statusCode === 429
  );
}
