/**
 * Unit tests for GET /api/scan/[address] — the public, unauthenticated
 * scan route.
 *
 * Verifies: address validation (400 on malformed), rate-limit enforcement
 * (429 when the backoff limiter denies, scanAddress NOT called), happy path
 * (200 + scanAddress called once with the rate-limit key `scan:<ip>`),
 * HARDEN-01 abuse telemetry on 429, and HARDEN-04 flag-gate 404.
 *
 * Mocks: incrementAndCheckWithBackoff, getRequestSourceIp, scanAddress,
 *        logAnonymousExecutionBlock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockIncrementAndCheck,
  mockGetRequestSourceIp,
  mockScanAddress,
  mockLogAnonymousExecutionBlock,
} = vi.hoisted(() => ({
  mockIncrementAndCheck: vi.fn(),
  mockGetRequestSourceIp: vi.fn(),
  mockScanAddress: vi.fn(),
  mockLogAnonymousExecutionBlock: vi.fn(),
}));

vi.mock("@/lib/scan/rate-limit", () => ({
  incrementAndCheckWithBackoff: mockIncrementAndCheck,
}));

vi.mock("@/lib/security/request-attribution", () => ({
  getRequestSourceIp: mockGetRequestSourceIp,
}));

vi.mock("@/lib/scan/scanner", () => ({
  scanAddress: mockScanAddress,
}));

vi.mock("@/lib/auth-anonymous-guard", () => ({
  logAnonymousExecutionBlock: mockLogAnonymousExecutionBlock,
}));

const { GET } = await import("@/app/api/scan/[address]/route");

const VALID_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const MOCK_IP = "1.2.3.4";

const ALLOWED_RATE = {
  allowed: true as const,
  count: 1,
  limit: 6,
  remaining: 5,
  reset: 9_999_999_999,
};

const DENIED_RATE = {
  allowed: false as const,
  retryAfter: 1200,
  count: 7,
  limit: 6,
  remaining: 0,
  reset: 9_999_999_999,
};

function makeRequest(address: string): Request {
  return new Request(`http://localhost/api/scan/${address}`, {
    headers: { "cf-connecting-ip": MOCK_IP },
  });
}

function makeParams(address: string): { params: Promise<{ address: string }> } {
  return { params: Promise.resolve({ address }) };
}

describe("GET /api/scan/[address]", () => {
  beforeEach(() => {
    mockIncrementAndCheck.mockReset();
    mockGetRequestSourceIp.mockReset();
    mockScanAddress.mockReset();
    mockLogAnonymousExecutionBlock.mockReset();
    mockGetRequestSourceIp.mockReturnValue(MOCK_IP);
    mockIncrementAndCheck.mockResolvedValue(ALLOWED_RATE);
    mockScanAddress.mockResolvedValue({
      schemaVersion: 1,
      address: VALID_ADDRESS,
      positions: [],
      stablecoins: [],
      unavailableChains: [],
      scannedAt: new Date().toISOString(),
    });
    // HARDEN-04: set the flag so existing tests keep passing once the gate
    // is added to the route in 55-03
    process.env.NEXT_PUBLIC_SCAN_ENABLED = "true";
  });

  it("invalid address: returns 400 without touching rate limit or scanner", async () => {
    const res = await GET(
      makeRequest("notanaddress"),
      makeParams("notanaddress")
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid address");
    expect(mockIncrementAndCheck).not.toHaveBeenCalled();
    expect(mockScanAddress).not.toHaveBeenCalled();
  });

  it("rate limit: returns 429 without calling scanAddress when the backoff limiter denies", async () => {
    mockIncrementAndCheck.mockResolvedValue(DENIED_RATE);
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("Rate limit exceeded");
    expect(body.retryAfter).toBe(1200);
    expect(mockScanAddress).not.toHaveBeenCalled();
  });

  it("happy path: returns 200 with scan result; scanAddress called once with rate-limit key scan:<ip>", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schemaVersion: number };
    expect(body.schemaVersion).toBe(1);
    expect(mockScanAddress).toHaveBeenCalledTimes(1);
    expect(mockScanAddress).toHaveBeenCalledWith(VALID_ADDRESS);
    expect(mockIncrementAndCheck).toHaveBeenCalledWith(
      `scan:${MOCK_IP}`,
      6,
      30
    );
  });

  // HARDEN-01: abuse telemetry on 429
  it("emits abuse telemetry before returning 429", async () => {
    mockIncrementAndCheck.mockResolvedValue(DENIED_RATE);
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(429);
    // RED: logAnonymousExecutionBlock is not yet called in the route (55-02 adds it)
    expect(mockLogAnonymousExecutionBlock).toHaveBeenCalledWith("scan", null, {
      ip: MOCK_IP,
      rateLimitCount: "7",
      address: VALID_ADDRESS,
    });
  });

  // HARDEN-04: feature flag gate
  it("returns 404 when NEXT_PUBLIC_SCAN_ENABLED is not 'true'", async () => {
    const saved = process.env.NEXT_PUBLIC_SCAN_ENABLED;
    try {
      process.env.NEXT_PUBLIC_SCAN_ENABLED = undefined;
      // RED: flag gate not yet added to the route (55-03 adds it)
      const res = await GET(
        makeRequest(VALID_ADDRESS),
        makeParams(VALID_ADDRESS)
      );
      expect(res.status).toBe(404);
      expect(mockIncrementAndCheck).not.toHaveBeenCalled();
      expect(mockScanAddress).not.toHaveBeenCalled();
    } finally {
      process.env.NEXT_PUBLIC_SCAN_ENABLED = saved;
    }
  });
});
