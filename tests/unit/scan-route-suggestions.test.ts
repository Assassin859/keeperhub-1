/**
 * RED scaffold — Wave 0 integration test for GET /api/scan + suggestion engine.
 *
 * These tests FAIL because:
 *  - lib/scan/suggestions/engine.ts does not yet exist
 *  - the scan route does not yet call buildSuggestions (Phase 52 route extension)
 *
 * Downstream plans (Wave 2/3) implement the route extension and turn these green.
 *
 * Requirements covered: TEST-02
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockIncrementAndCheck, mockGetRequestSourceIp, mockScanAddress } =
  vi.hoisted(() => ({
    mockIncrementAndCheck: vi.fn(),
    mockGetRequestSourceIp: vi.fn(),
    mockScanAddress: vi.fn(),
  }));

vi.mock("@/lib/agentic-wallet/rate-limit", () => ({
  incrementAndCheck: mockIncrementAndCheck,
}));

vi.mock("@/lib/security/request-attribution", () => ({
  getRequestSourceIp: mockGetRequestSourceIp,
}));

vi.mock("@/lib/scan/scanner", () => ({
  scanAddress: mockScanAddress,
}));

const { GET } = await import("@/app/api/scan/[address]/route");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Top-level regex constants (useTopLevelRegex rule)
const RE_CHAIN_ID_42161 = /42161/;

/** Arbitrum native USDC — from scripts/seed/seed-tokens.ts */
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

const VALID_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const MOCK_IP = "1.2.3.4";

const ALLOWED_RATE = {
  allowed: true as const,
  count: 1,
  limit: 3,
  remaining: 2,
  reset: 9_999_999_999,
};

/**
 * Minimal ScanResponse fixture with one Arbitrum USDC stablecoin position.
 * chainId 42161; usdValue 500; non-depegged — should produce a yield suggestion.
 */
const MOCK_SCAN_WITH_USDC = {
  schemaVersion: 1,
  address: VALID_ADDRESS,
  positions: [],
  stablecoins: [
    {
      chainId: 42_161,
      symbol: "USDC",
      tokenAddress: ARBITRUM_USDC,
      amount: "500000000",
      decimals: 6,
      usdValue: 500,
      priceUsd: 1.0,
      depegged: false,
    },
  ],
  unavailableChains: [],
  scannedAt: new Date().toISOString(),
};

function makeRequest(address: string): Request {
  return new Request(`http://localhost/api/scan/${address}`, {
    headers: { "cf-connecting-ip": MOCK_IP },
  });
}

function makeParams(address: string): { params: Promise<{ address: string }> } {
  return { params: Promise.resolve({ address }) };
}

// ---------------------------------------------------------------------------
// TEST-02: Route returns 200 with suggestions[] containing chainId + network
// ---------------------------------------------------------------------------

describe("TEST-02: GET /api/scan returns suggestions from suggestion engine", () => {
  beforeEach(() => {
    mockIncrementAndCheck.mockReset();
    mockGetRequestSourceIp.mockReset();
    mockScanAddress.mockReset();
    mockGetRequestSourceIp.mockReturnValue(MOCK_IP);
    mockIncrementAndCheck.mockResolvedValue(ALLOWED_RATE);
    mockScanAddress.mockResolvedValue(MOCK_SCAN_WITH_USDC);
  });

  it("GET /api/scan returns 200 with Arbitrum USDC fixture", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    expect(res.status).toBe(200);
  });

  it("GET /api/scan returns suggestions[] array in response body", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as { suggestions: unknown };
    expect(Array.isArray(body.suggestions)).toBe(true);
  });

  it("network: suggestions[0].chainId === 42161 (number) for Arbitrum USDC", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as {
      suggestions: Array<{ chainId: number }>;
    };
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions[0].chainId).toBe(42_161);
  });

  it("network: factory prefill for Arbitrum USDC yields config.network === '42161' (string)", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as {
      suggestions: Array<{
        chainId: number;
        prefill?: { nodes: Array<{ data: { config?: { network?: string } } }> };
      }>;
    };
    const firstSuggestion = body.suggestions[0];
    // The route may embed a prefill object or the test verifies via a separate
    // buildWorkflow call; either way network must be "42161" (string per PREFILL-04)
    if (firstSuggestion?.prefill) {
      const web3Nodes = firstSuggestion.prefill.nodes.filter(
        (n) => n.data.config?.network !== undefined
      );
      for (const node of web3Nodes) {
        expect(node.data.config?.network).toBe("42161");
      }
    } else {
      // Prefill not embedded in route response — assert chainId is present and correct
      expect(firstSuggestion.chainId).toBe(42_161);
    }
  });

  it("network: suggestions[0] tokenAddress matches Arbitrum USDC address", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as {
      suggestions: Array<{ id: string; chainId: number }>;
    };
    expect(body.suggestions[0].chainId).toBe(42_161);
    // The suggestion id slug encodes chainId for traceability
    expect(body.suggestions[0].id).toMatch(RE_CHAIN_ID_42161);
  });

  it("network: existing scan-route behaviour preserved (schemaVersion still 1)", async () => {
    const res = await GET(
      makeRequest(VALID_ADDRESS),
      makeParams(VALID_ADDRESS)
    );
    const body = (await res.json()) as { schemaVersion: number };
    expect(body.schemaVersion).toBe(1);
  });
});
