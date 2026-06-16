/**
 * Unit tests for GET /api/scan/[address] — the public, unauthenticated
 * scan route.
 *
 * Verifies: address validation (400 on malformed), rate-limit enforcement
 * (429 on 4th/hr from same IP, scanAddress NOT called), and happy path
 * (200 + scanAddress called once with the rate-limit key `scan:<ip>`).
 *
 * Mocks: incrementAndCheck, resolveTrustedClientIp, scanAddress.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockIncrementAndCheck, mockResolveTrustedClientIp, mockScanAddress } =
  vi.hoisted(() => ({
    mockIncrementAndCheck: vi.fn(),
    mockResolveTrustedClientIp: vi.fn(),
    mockScanAddress: vi.fn(),
  }));

vi.mock("@/lib/agentic-wallet/rate-limit", () => ({
  incrementAndCheck: mockIncrementAndCheck,
}));

vi.mock("@/lib/security/trusted-proxies", () => ({
  resolveTrustedClientIp: mockResolveTrustedClientIp,
}));

vi.mock("@/lib/scan/scanner", () => ({
  scanAddress: mockScanAddress,
}));

const { GET } = await import("@/app/api/scan/[address]/route");

const VALID_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const MOCK_IP = "1.2.3.4";

const ALLOWED_RATE = {
  allowed: true as const,
  count: 1,
  limit: 3,
  remaining: 2,
  reset: 9_999_999_999,
};

const DENIED_RATE = {
  allowed: false as const,
  retryAfter: 1200,
  count: 4,
  limit: 3,
  remaining: 0,
  reset: 9_999_999_999,
};

function makeRequest(address: string): Request {
  return new Request(`http://localhost/api/scan/${address}`, {
    headers: { "x-real-ip": MOCK_IP },
  });
}

function makeParams(address: string): { params: Promise<{ address: string }> } {
  return { params: Promise.resolve({ address }) };
}

describe("GET /api/scan/[address]", () => {
  beforeEach(() => {
    mockIncrementAndCheck.mockReset();
    mockResolveTrustedClientIp.mockReset();
    mockScanAddress.mockReset();
    mockResolveTrustedClientIp.mockReturnValue(MOCK_IP);
    mockIncrementAndCheck.mockResolvedValue(ALLOWED_RATE);
    mockScanAddress.mockResolvedValue({
      schemaVersion: 1,
      address: VALID_ADDRESS,
      positions: [],
      stablecoins: [],
      unavailableChains: [],
      scannedAt: new Date().toISOString(),
    });
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

  it("rate limit: returns 429 without calling scanAddress (4th/hr from same IP)", async () => {
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
    expect(mockIncrementAndCheck).toHaveBeenCalledWith(`scan:${MOCK_IP}`, 3);
  });
});
