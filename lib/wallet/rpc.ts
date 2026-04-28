/**
 * Shared JSON-RPC client for wallet balance fetches.
 *
 * Consolidates retry/backoff semantics and payload encoding used by the
 * native and ERC20 balance fetchers. Split into its own module so the
 * retry logic can be unit-tested without pulling the balance-formatting
 * machinery.
 */

import { addBreadcrumb } from "@sentry/nextjs";

const BIGINT_ZERO = BigInt(0);
const EVM_ADDRESS_REGEX = /^(0x)?[0-9a-fA-F]{40}$/;
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";
const ERC20_ADDRESS_PADDING = 64;

export type RpcFailureKind = "standard" | "rate_limit";

export type JsonRpcPayload = {
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
  id: number;
};

/**
 * RPC retry configuration.
 *
 * Two exponential-backoff schedules with jitter, picked by failure type:
 *
 * - `STANDARD`: network errors, HTTP 5xx, and malformed responses (missing
 *   `result` field). Short backoff because these usually clear quickly.
 * - `RATE_LIMIT`: HTTP 429. Longer backoff because the server is actively
 *   throttling us; retrying too soon just extends the throttle.
 *
 * Each delay = `min((BASE_MS * 2^attempt) + jitter, ABSOLUTE_MAX_BACKOFF_MS)`
 * where `jitter = random() * base * JITTER_FACTOR`.
 *
 * `RETRIES_PER_URL_WITH_FAILOVER` applies when `rpcCallWithFailover` has a
 * fallback URL available — retry fewer times per URL so we hand off to the
 * fallback sooner when the primary is throttled or flaky.
 */
export const RPC_RETRY_CONFIG = {
  MAX_RETRIES: 3,
  RETRIES_PER_URL_WITH_FAILOVER: 1,
  JITTER_FACTOR: 0.3,
  ABSOLUTE_MAX_BACKOFF_MS: 5000,
  STANDARD: {
    BASE_MS: 500,
    CAP_MS: 3000,
  },
  RATE_LIMIT: {
    BASE_MS: 1000,
    CAP_MS: 5000,
  },
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the backoff delay for a given retry attempt and failure kind.
 * Adds randomized jitter to avoid lockstep retries across concurrent callers.
 * Guaranteed to return at most `RPC_RETRY_CONFIG.ABSOLUTE_MAX_BACKOFF_MS`.
 */
export function getRpcBackoffMs(
  attempt: number,
  kind: RpcFailureKind
): number {
  const schedule =
    kind === "rate_limit"
      ? RPC_RETRY_CONFIG.RATE_LIMIT
      : RPC_RETRY_CONFIG.STANDARD;
  const base = Math.min(schedule.BASE_MS * 2 ** attempt, schedule.CAP_MS);
  const jitter = Math.random() * base * RPC_RETRY_CONFIG.JITTER_FACTOR;
  return Math.min(base + jitter, RPC_RETRY_CONFIG.ABSOLUTE_MAX_BACKOFF_MS);
}

/**
 * Encode an ERC20 `balanceOf(address)` call payload.
 * Validates the address is a well-formed 20-byte hex string to prevent
 * silent mis-encoding from over-long input slipping past `padStart`.
 */
export function encodeBalanceOfCallData(address: string): string {
  if (!EVM_ADDRESS_REGEX.test(address)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  const stripped = address.startsWith("0x") ? address.slice(2) : address;
  const padded = stripped.toLowerCase().padStart(ERC20_ADDRESS_PADDING, "0");
  return `${ERC20_BALANCE_OF_SELECTOR}${padded}`;
}

/**
 * Parse a hex wei string into BigInt, treating empty `"0x"` as zero.
 * `rpcCall` guarantees the input is a non-empty string.
 */
export function hexWeiToBigInt(hex: string): bigint {
  return hex === "0x" ? BIGINT_ZERO : BigInt(hex);
}

/**
 * Execute a JSON-RPC POST with retry/backoff for transient failures.
 *
 * Retries: HTTP 429, HTTP 5xx, network errors, and missing `result` fields
 * (malformed gateway responses — the root cause behind `BigInt(undefined)`).
 * Does not retry HTTP 4xx (except 429) or RPC-reported errors — those are
 * deterministic and would fail again.
 *
 * Each retry adds a Sentry breadcrumb so the retry history is attached to
 * any error eventually captured on the same scope.
 *
 * Returns the raw `result` string (guaranteed non-empty). Callers interpret
 * `"0x"` per their context via {@link hexWeiToBigInt}.
 */
export async function rpcCall(
  rpcUrl: string,
  payload: JsonRpcPayload,
  maxRetries: number = RPC_RETRY_CONFIG.MAX_RETRIES
): Promise<string> {
  let lastError: Error = new Error("RPC call failed");
  let lastFailureKind: RpcFailureKind = "standard";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = getRpcBackoffMs(attempt - 1, lastFailureKind);
      addBreadcrumb({
        category: "rpc.retry",
        level: "info",
        message: `Retrying RPC after ${lastFailureKind} failure: ${lastError.message}`,
        data: {
          url: rpcUrl,
          method: payload.method,
          attempt,
          backoffMs: Math.round(backoffMs),
          kind: lastFailureKind,
        },
      });
      await delay(backoffMs);
    }

    let response: Response;
    try {
      response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastFailureKind = "standard";
      continue;
    }

    if (response.status === 429) {
      lastError = new Error("HTTP 429: rate limited");
      lastFailureKind = "rate_limit";
      continue;
    }

    if (response.status >= 500) {
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      lastFailureKind = "standard";
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "RPC error");
    }

    if (data.result === undefined || data.result === null) {
      lastError = new Error("RPC returned no result");
      lastFailureKind = "standard";
      continue;
    }

    return data.result;
  }

  throw lastError;
}

/**
 * Execute a JSON-RPC call across a primary URL with optional fallbacks.
 *
 * When more than one URL is provided, each URL uses the reduced
 * `RETRIES_PER_URL_WITH_FAILOVER` budget so a throttled primary hands off to
 * the fallback quickly instead of burning the full retry schedule first.
 *
 * Throws the last error after all URLs are exhausted. A Sentry breadcrumb is
 * emitted for every failover hop.
 */
export async function rpcCallWithFailover(
  rpcUrls: ReadonlyArray<string>,
  payload: JsonRpcPayload
): Promise<string> {
  if (rpcUrls.length === 0) {
    throw new Error("rpcCallWithFailover requires at least one URL");
  }

  const maxRetries =
    rpcUrls.length > 1
      ? RPC_RETRY_CONFIG.RETRIES_PER_URL_WITH_FAILOVER
      : RPC_RETRY_CONFIG.MAX_RETRIES;

  let lastError: Error = new Error("RPC call failed");

  for (const [i, url] of rpcUrls.entries()) {
    try {
      return await rpcCall(url, payload, maxRetries);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const nextUrl = rpcUrls[i + 1];
      if (nextUrl) {
        addBreadcrumb({
          category: "rpc.failover",
          level: "info",
          message: `RPC primary failed, failing over: ${lastError.message}`,
          data: {
            method: payload.method,
            failedUrl: url,
            nextUrl,
          },
        });
      }
    }
  }

  throw lastError;
}
