import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/wallet/rpc.ts` now imports `lib/safe-fetch`, which declares
// `import "server-only"` and would otherwise throw under vitest.
vi.mock("server-only", () => ({}));

const { addBreadcrumbMock, safeFetchMock } = vi.hoisted(() => ({
  addBreadcrumbMock: vi.fn(),
  safeFetchMock: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args),
  captureException: vi.fn(),
}));

// `rpcCall` calls `safeFetch`, which uses undici directly and bypasses
// `globalThis.fetch`. Mock at the safe-fetch boundary so the existing
// retry/failover assertions still work.
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

import {
  encodeBalanceOfCallData,
  getRpcBackoffMs,
  hexWeiToBigInt,
  type JsonRpcPayload,
  RPC_RETRY_CONFIG,
  rpcCall,
  rpcCallWithFailover,
} from "@/lib/wallet/rpc";

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const TEST_RPC_URL = "https://rpc.example.test";
const TEST_PAYLOAD: JsonRpcPayload = {
  jsonrpc: "2.0",
  method: "eth_getBalance",
  params: [VALID_ADDRESS, "latest"],
  id: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function plainResponse(status: number, statusText = ""): Response {
  return new Response(null, { status, statusText });
}

describe("encodeBalanceOfCallData", () => {
  it("encodes a 0x-prefixed address", () => {
    const data = encodeBalanceOfCallData(VALID_ADDRESS);
    expect(data).toBe(
      "0x70a08231000000000000000000000000" +
        "1234567890abcdef1234567890abcdef12345678"
    );
  });

  it("encodes an unprefixed address", () => {
    const data = encodeBalanceOfCallData(VALID_ADDRESS.slice(2));
    expect(data).toBe(
      "0x70a08231000000000000000000000000" +
        "1234567890abcdef1234567890abcdef12345678"
    );
  });

  it("lowercases mixed-case input", () => {
    const data = encodeBalanceOfCallData(
      "0x1234567890ABCDEF1234567890abcdef12345678"
    );
    expect(data).toContain("1234567890abcdef1234567890abcdef12345678");
  });

  it("throws on too-short input", () => {
    expect(() => encodeBalanceOfCallData("0x1234")).toThrow(
      /Invalid EVM address/
    );
  });

  it("throws on too-long input", () => {
    expect(() => encodeBalanceOfCallData(`${VALID_ADDRESS}deadbeef`)).toThrow(
      /Invalid EVM address/
    );
  });

  it("throws on non-hex characters", () => {
    expect(() =>
      encodeBalanceOfCallData("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
    ).toThrow(/Invalid EVM address/);
  });
});

describe("hexWeiToBigInt", () => {
  it('treats "0x" as zero', () => {
    expect(hexWeiToBigInt("0x")).toBe(BigInt(0));
  });

  it('parses "0x0" as zero', () => {
    expect(hexWeiToBigInt("0x0")).toBe(BigInt(0));
  });

  it("parses a non-zero hex value", () => {
    expect(hexWeiToBigInt("0x1bc16d674ec80000")).toBe(
      BigInt("2000000000000000000")
    );
  });
});

describe("getRpcBackoffMs", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the base delay for standard attempt 0 with no jitter", () => {
    expect(getRpcBackoffMs(0, "standard")).toBe(
      RPC_RETRY_CONFIG.STANDARD.BASE_MS
    );
  });

  it("doubles the base delay for standard attempt 1", () => {
    expect(getRpcBackoffMs(1, "standard")).toBe(
      RPC_RETRY_CONFIG.STANDARD.BASE_MS * 2
    );
  });

  it("caps standard backoff at CAP_MS", () => {
    expect(getRpcBackoffMs(20, "standard")).toBeLessThanOrEqual(
      RPC_RETRY_CONFIG.STANDARD.CAP_MS
    );
  });

  it("uses longer base for rate_limit", () => {
    expect(getRpcBackoffMs(0, "rate_limit")).toBe(
      RPC_RETRY_CONFIG.RATE_LIMIT.BASE_MS
    );
  });

  it("never exceeds ABSOLUTE_MAX_BACKOFF_MS even with maximum jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(getRpcBackoffMs(attempt, "standard")).toBeLessThanOrEqual(
        RPC_RETRY_CONFIG.ABSOLUTE_MAX_BACKOFF_MS
      );
      expect(getRpcBackoffMs(attempt, "rate_limit")).toBeLessThanOrEqual(
        RPC_RETRY_CONFIG.ABSOLUTE_MAX_BACKOFF_MS
      );
    }
  });

  it("adds jitter proportional to the base delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const base = RPC_RETRY_CONFIG.STANDARD.BASE_MS;
    const expectedJitter = 0.5 * base * RPC_RETRY_CONFIG.JITTER_FACTOR;
    expect(getRpcBackoffMs(0, "standard")).toBeCloseTo(base + expectedJitter);
  });
});

describe("rpcCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    addBreadcrumbMock.mockClear();
    safeFetchMock.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if (outcome.ok) {
      return outcome.value;
    }
    throw outcome.error;
  }

  it("returns the result on first success", async () => {
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1234" })
    );

    const result = await runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD));

    expect(result).toBe("0x1234");
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });

  it("retries on 429 then succeeds", async () => {
    safeFetchMock
      .mockResolvedValueOnce(plainResponse(429, "Too Many Requests"))
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xdead" })
      );

    const result = await runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD));

    expect(result).toBe("0xdead");
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "rpc.retry",
        data: expect.objectContaining({ kind: "rate_limit", attempt: 1 }),
      })
    );
  });

  it("retries on 5xx then succeeds", async () => {
    safeFetchMock
      .mockResolvedValueOnce(plainResponse(502, "Bad Gateway"))
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" })
      );

    const result = await runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD));

    expect(result).toBe("0x1");
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "standard" }),
      })
    );
  });

  it("retries on network error then succeeds", async () => {
    safeFetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x2" })
      );

    const result = await runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD));

    expect(result).toBe("0x2");
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries when result is missing then succeeds", async () => {
    safeFetchMock
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x3" })
      );

    const result = await runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD));

    expect(result).toBe("0x3");
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on RPC-reported error without retrying", async () => {
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_000, message: "execution reverted" },
      })
    );

    await expect(
      runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD))
    ).rejects.toThrow(/execution reverted/);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on non-429 4xx without retrying", async () => {
    safeFetchMock.mockResolvedValueOnce(plainResponse(404, "Not Found"));

    await expect(
      runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD))
    ).rejects.toThrow(/HTTP 404/);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting retries", async () => {
    safeFetchMock.mockResolvedValue(plainResponse(429, "Too Many Requests"));

    await expect(
      runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD))
    ).rejects.toThrow(/HTTP 429/);
    expect(safeFetchMock).toHaveBeenCalledTimes(
      RPC_RETRY_CONFIG.MAX_RETRIES + 1
    );
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(
      RPC_RETRY_CONFIG.MAX_RETRIES
    );
  });

  it("honors the custom maxRetries argument", async () => {
    safeFetchMock.mockResolvedValue(plainResponse(429, "Too Many Requests"));

    await expect(
      runWithTimers(rpcCall(TEST_RPC_URL, TEST_PAYLOAD, 1))
    ).rejects.toThrow(/HTTP 429/);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("rpcCallWithFailover", () => {
  const PRIMARY_URL = "https://primary.rpc.test";
  const FALLBACK_URL = "https://fallback.rpc.test";

  beforeEach(() => {
    vi.useFakeTimers();
    addBreadcrumbMock.mockClear();
    safeFetchMock.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if (outcome.ok) {
      return outcome.value;
    }
    throw outcome.error;
  }

  it("returns the primary result when primary succeeds", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xprimary" })
    );

    const result = await runWithTimers(
      rpcCallWithFailover([PRIMARY_URL, FALLBACK_URL], TEST_PAYLOAD)
    );

    expect(result).toBe("0xprimary");
    expect(safeFetchMock).toHaveBeenCalledWith(PRIMARY_URL, expect.anything());
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails over to the fallback URL when primary is exhausted", async () => {
    safeFetchMock.mockImplementation((url: string) => {
      if (url === PRIMARY_URL) {
        return Promise.resolve(plainResponse(429, "Too Many Requests"));
      }
      return Promise.resolve(
        jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xfallback" })
      );
    });

    const result = await runWithTimers(
      rpcCallWithFailover([PRIMARY_URL, FALLBACK_URL], TEST_PAYLOAD)
    );

    expect(result).toBe("0xfallback");
    // Primary uses the reduced retry budget (1 retry => 2 attempts).
    const primaryAttempts = safeFetchMock.mock.calls.filter(
      ([url]) => url === PRIMARY_URL
    ).length;
    expect(primaryAttempts).toBe(
      RPC_RETRY_CONFIG.RETRIES_PER_URL_WITH_FAILOVER + 1
    );
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "rpc.failover",
        data: expect.objectContaining({
          failedUrl: PRIMARY_URL,
          nextUrl: FALLBACK_URL,
        }),
      })
    );
  });

  it("throws the last error when every URL is exhausted", async () => {
    safeFetchMock.mockResolvedValue(plainResponse(429, "Too Many Requests"));

    await expect(
      runWithTimers(
        rpcCallWithFailover([PRIMARY_URL, FALLBACK_URL], TEST_PAYLOAD)
      )
    ).rejects.toThrow(/HTTP 429/);
  });

  it("does not emit a failover breadcrumb when there is only one URL", async () => {
    safeFetchMock.mockResolvedValue(plainResponse(429, "Too Many Requests"));

    await expect(
      runWithTimers(rpcCallWithFailover([PRIMARY_URL], TEST_PAYLOAD))
    ).rejects.toThrow(/HTTP 429/);
    const failoverBreadcrumbs = addBreadcrumbMock.mock.calls.filter(
      (args) => (args[0] as { category?: string }).category === "rpc.failover"
    );
    expect(failoverBreadcrumbs).toHaveLength(0);
  });

  it("rejects an empty URL list", async () => {
    await expect(
      runWithTimers(rpcCallWithFailover([], TEST_PAYLOAD))
    ).rejects.toThrow(/at least one URL/);
  });
});
