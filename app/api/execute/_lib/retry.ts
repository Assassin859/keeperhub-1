import "server-only";

import type { RetryConfig } from "./types";

const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;

export type TransactionResult =
  | { success: true; transactionHash: string; [key: string]: unknown }
  | { success: false; error: string };

type ExecuteFn<T> = () => Promise<T>;

/**
 * Determines whether a result represents a successful execution.
 * Return true to stop retrying, false to retry (if attempts remain).
 */
type SuccessPredicate<T> = (result: T) => boolean;

/**
 * Extracts an error message from a failed result for retryability checks.
 * Return undefined if the result has no extractable error string.
 */
type ErrorExtractor<T> = (result: T) => string | undefined;

function resolveConfig(config?: RetryConfig): Required<RetryConfig> {
  return {
    maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs)
    ),
  ]);
}

export type RetryResult<T> =
  | { outcome: "success"; result: T; retryCount: number }
  | { outcome: "failed"; result: T; retryCount: number }
  | { outcome: "timeout"; error: string; retryCount: number }
  | { outcome: "exhausted"; error: string; retryCount: number };

type RetryOptions<T> = {
  isSuccess: SuccessPredicate<T>;
  getError: ErrorExtractor<T>;
};

const TX_SUCCESS: SuccessPredicate<TransactionResult> = (r) => r.success;
const TX_ERROR: ErrorExtractor<TransactionResult> = (r) =>
  r.success ? undefined : r.error;

/**
 * Default options for web3 TransactionResult-shaped outputs.
 */
export const transactionRetryOptions: RetryOptions<TransactionResult> = {
  isSuccess: TX_SUCCESS,
  getError: TX_ERROR,
};

/**
 * Options for generic (non-web3) step outputs. Any non-throwing return
 * is treated as success; retries only happen on timeout.
 */
export const genericRetryOptions: RetryOptions<unknown> = {
  isSuccess: () => true,
  getError: () => undefined,
};

/**
 * Execute a function with automatic retry.
 *
 * A retry re-runs executeFn from scratch. It is not a replacement transaction:
 * nothing is pinned, so a web3 step that retries opens a new nonce session and
 * signs an independent transaction at the next nonce. Retries are therefore
 * only safe when the previous attempt is known not to have broadcast, which is
 * what isRetryableError below is responsible for deciding.
 *
 * The timeout path is the exception, and the caller carries it: on timeout the
 * in-flight executeFn promise is abandoned but not cancelled, and a transaction
 * it already broadcast can still confirm. A timeoutMs below the chain's
 * confirmation latency can therefore produce two confirmed transactions. Set
 * timeoutMs above the confirmation latency of the target chain.
 */
export async function executeWithRetry<T>(
  executeFn: ExecuteFn<T>,
  config: RetryConfig | undefined,
  options: RetryOptions<T>
): Promise<RetryResult<T>> {
  const resolved = resolveConfig(config);
  let retryCount = 0;

  for (let attempt = 0; attempt <= resolved.maxRetries; attempt++) {
    const resultOrTimeout = await withTimeout(executeFn(), resolved.timeoutMs);

    if (resultOrTimeout === "timeout") {
      if (attempt >= resolved.maxRetries) {
        return {
          outcome: "timeout",
          error: `Timed out after ${resolved.maxRetries} retries`,
          retryCount,
        };
      }
      retryCount++;
      continue;
    }

    if (options.isSuccess(resultOrTimeout)) {
      return { outcome: "success", result: resultOrTimeout, retryCount };
    }

    const errorMsg = options.getError(resultOrTimeout);
    const isRetryable = errorMsg ? isRetryableError(errorMsg) : false;
    if (!isRetryable || attempt >= resolved.maxRetries) {
      return { outcome: "failed", result: resultOrTimeout, retryCount };
    }

    retryCount++;
  }

  return {
    outcome: "exhausted",
    error: "Max retries exceeded",
    retryCount,
  };
}

/**
 * Connection-level failures only: the attempt came back with no result at all.
 * A retry signs a fresh transaction at the next nonce, so nothing that says a
 * transaction is already live may be listed here - "nonce has already been
 * used", "already known", "replacement fee too low" and "transaction
 * underpriced" each report a broadcast that happened, and retrying on them
 * sends a second, independent transaction rather than replacing the first.
 */
const RETRYABLE_PATTERNS = ["timeout", "ETIMEDOUT", "ECONNRESET"];

function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) =>
    lower.includes(pattern.toLowerCase())
  );
}
