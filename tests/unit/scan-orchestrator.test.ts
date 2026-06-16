/**
 * Tests for the scan orchestrator (scanner.ts) — cache short-circuit and
 * cache-miss assembly.
 *
 * TDD: tests written first (RED), implementation added after (GREEN).
 *
 * Tests:
 *   A — cache-hit: returns cached ScanResponse and makes zero RPC calls
 *   B — cache-miss: assembles ScanResponse with schemaVersion:1, checksummed
 *       address, detected positions[], and writes a cache row with a future
 *       expiresAt (~5-min TTL)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── Mock function handles (declared before vi.mock so factories close over them) ─

const mockAggregate3StaticCall = vi.fn();
const mockDbSelectFn = vi.fn();
const mockDbInsertFn = vi.fn();
const mockGetRpcProvider = vi.fn();
const mockGetEnabledChains = vi.fn();

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelectFn,
    insert: mockDbInsertFn,
  },
}));

vi.mock("@/lib/rpc/chain-service", () => ({
  getEnabledChains: mockGetEnabledChains,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

vi.mock("@/lib/scan/zerion-fallback", () => ({
  maybeZerionFallback: vi.fn().mockResolvedValue([]),
  isZerionEnabled: vi.fn().mockReturnValue(false),
}));

// Prevent HTTP calls from DefiLlama during tests (no stablecoins in these tests,
// but belt-and-suspenders guard in case the pricing layer is invoked).
vi.mock("@/lib/scan/price/defillama", () => ({
  fetchDefillamaPrice: vi.fn().mockResolvedValue(null),
}));

// Mock ethers.Contract only — all other ethers methods (Interface, AbiCoder,
// getAddress, isAddress) remain real so test helpers can encode/decode data.
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        aggregate3 = { staticCall: mockAggregate3StaticCall };
      },
    },
  };
});

// ─── Imports (after vi.mock so hoisting is complete) ─────────────────────────

import { ethers } from "ethers";
import { SCAN_SCHEMA_VERSION, type ScanResponse } from "@/lib/scan/types";

// ─── Shared test data ─────────────────────────────────────────────────────────

// A valid, already-checksummed Ethereum address used across all tests.
const TEST_RAW = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TEST_LC = TEST_RAW.toLowerCase();
const TEST_CHECKSUMMED = ethers.getAddress(TEST_RAW);

const CACHED_RESPONSE: ScanResponse = {
  schemaVersion: SCAN_SCHEMA_VERSION,
  address: TEST_CHECKSUMMED,
  positions: [],
  stablecoins: [],
  unavailableChains: [],
  scannedAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
};

// ─── Aave V3 encoding helpers ─────────────────────────────────────────────────

// Minimal Aave V3 Pool ABI for getUserAccountData + getUserEMode encoding.
// Mirrors lib/scan/adapters/aave-v3.ts without importing mocked modules.
const POOL_ABI_FRAGMENT = [
  {
    name: "getUserAccountData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  {
    name: "getUserEMode",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const MAX_UINT256 = BigInt(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
);

// Lazy-init the pool interface so vi.mock("ethers") hoisting has already run.
let poolIface: ethers.Interface | null = null;
function getPoolIface(): ethers.Interface {
  if (!poolIface) {
    poolIface = new ethers.Interface(
      POOL_ABI_FRAGMENT as unknown as ethers.InterfaceAbi
    );
  }
  return poolIface;
}

/**
 * ABI-encode a getUserAccountData result tuple.
 * Supply-only user: totalCollateralBase > 0, totalDebtBase = 0,
 * healthFactor = MAX_UINT256.
 */
function encodeSupplyOnlyAccountData(): string {
  return getPoolIface().encodeFunctionResult("getUserAccountData", [
    BigInt(100_000_000), // totalCollateralBase: $1.00 in 8-decimal USD base units
    BigInt(0), // totalDebtBase: no debt
    BigInt(0), // availableBorrowsBase
    BigInt(8000), // currentLiquidationThreshold
    BigInt(7500), // ltv
    MAX_UINT256, // healthFactor: sentinel for no-debt
  ]);
}

/** ABI-encode a getUserEMode result (eMode category = 0 → no eMode). */
function encodeEMode(): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(0)]);
}

/** ABI-encode a uint256 zero — used for ERC20 balanceOf = 0. */
function encodeZeroBalance(): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(0)]);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("scan orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default db.insert mock — overridden per-test as needed.
    const mockValues = vi.fn().mockResolvedValue(undefined);
    mockDbInsertFn.mockReturnValue({ values: mockValues });

    // Default RPC provider — overridden per-test as needed.
    mockGetRpcProvider.mockResolvedValue({
      executeWithFailover: vi
        .fn()
        .mockImplementation((fn: (p: unknown) => unknown) => fn({})),
    });
  });

  // ─── Test A: cache-hit ─────────────────────────────────────────────────────

  describe("cache-hit", () => {
    it("returns the cached ScanResponse and issues zero getRpcProvider calls on a fresh row", async () => {
      // Cache check → fresh row present (expiresAt 4 min from now).
      mockDbSelectFn.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: "row-1",
                address: TEST_LC,
                resultJson: CACHED_RESPONSE,
                scannedAt: new Date(Date.now() - 60_000),
                expiresAt: new Date(Date.now() + 4 * 60 * 1000),
              },
            ]),
          }),
        }),
      });

      // Dynamically import scanAddress to avoid circular mock issues.
      const { scanAddress } = await import("@/lib/scan/scanner");
      const result = await scanAddress(TEST_RAW);

      expect(result).toEqual(CACHED_RESPONSE);
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
    });
  });

  // ─── Test B: cache-miss assembles ─────────────────────────────────────────

  describe("cache-miss assembles", () => {
    it("returns schemaVersion:1, checksummed address, Aave position, and writes cache row with future expiresAt", async () => {
      // db.select call sequence:
      //   1st: cache check    → miss (empty array)
      //   2nd: stablecoin query for chain 1 → empty (simplifies pricing)
      let selectIdx = 0;
      mockDbSelectFn.mockImplementation(() => {
        selectIdx += 1;
        if (selectIdx === 1) {
          // Cache check — miss
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        // Stablecoin query — no tokens (avoids pricing complexity)
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      });

      // Chains: Ethereum only (chainId 1 is in both AAVE_V3_POOLS and LIDO_TOKENS).
      mockGetEnabledChains.mockResolvedValue([
        { id: "eth-1", chainId: 1, name: "Ethereum", isEnabled: true },
      ]);

      // aggregate3 returns 4 results for chain 1:
      //   [0] getUserAccountData  (Aave — supply-only user)
      //   [1] getUserEMode        (Aave — eMode = 0)
      //   [2] stETH balanceOf     (Lido — 0, no position)
      //   [3] wstETH balanceOf    (Lido — 0, no position)
      mockAggregate3StaticCall.mockResolvedValue([
        [true, encodeSupplyOnlyAccountData()],
        [true, encodeEMode()],
        [true, encodeZeroBalance()], // stETH
        [true, encodeZeroBalance()], // wstETH
      ]);

      // Cache write spy.
      const mockInsertValues = vi.fn().mockResolvedValue(undefined);
      mockDbInsertFn.mockReturnValue({ values: mockInsertValues });

      const { scanAddress } = await import("@/lib/scan/scanner");
      const result = await scanAddress(TEST_RAW);

      // Schema shape
      expect(result.schemaVersion).toBe(SCAN_SCHEMA_VERSION);
      expect(result.address).toBe(TEST_CHECKSUMMED);
      expect(typeof result.scannedAt).toBe("string");

      // Aave V3 supply-only position detected
      expect(result.positions).toHaveLength(1);
      const position = result.positions[0];
      expect(position?.protocol).toBe("aave-v3");
      expect(position?.chainId).toBe(1);
      expect(position?.healthFactor).toBeNull(); // no debt → null
      expect(position?.noActiveLoan).toBe(true);

      // No Lido position (both balances are 0)
      expect(
        result.positions.filter(
          (p: { protocol: string }) => p.protocol === "lido"
        )
      ).toHaveLength(0);

      // No stablecoins (empty token registry for chain 1 in this test)
      expect(result.stablecoins).toHaveLength(0);

      // Cache write asserted
      expect(mockDbInsertFn).toHaveBeenCalledOnce();
      const writeRow = mockInsertValues.mock.calls[0]?.[0] as {
        address: string;
        expiresAt: Date;
        resultJson: ScanResponse;
      };
      expect(writeRow.address).toBe(TEST_LC);
      expect(writeRow.expiresAt).toBeInstanceOf(Date);
      // expiresAt must be > 4 min from now (validating ~5-min TTL)
      expect(writeRow.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 4 * 60 * 1000
      );
      expect(writeRow.resultJson.schemaVersion).toBe(SCAN_SCHEMA_VERSION);
    });
  });
});
