/**
 * TEST-01 anchor: Scanner correctness guards — four in-file guard todos.
 *
 * Guard ownership:
 *   HF MAX_UINT256  — filled by Plan 05 (Wave 3)
 *   soft-miss       — filled by Plan 03 (Wave 2)
 *   proxy           — filled by Plan 05 (Wave 3)
 *   unavailable     — filled by Plan 03 (Wave 2)
 *
 * Sibling files own the remaining guards:
 *   depeg guard      — tests/unit/scan-pricing.test.ts  (Plan 04)
 *   rate-limit guard — tests/unit/scan-route.test.ts    (Plan 08)
 *
 * Shared helpers exported here (`encodeAccountData`, `AAVE_V3_POOL_ABI_FRAGMENT`)
 * are imported by sibling test files so encoding is consistent across the suite.
 */

import { describe, it, vi } from "vitest";

// ─── Module mocks (hoisted before imports by vitest) ─────────────────────────

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn().mockResolvedValue({
    executeWithFailover: vi
      .fn()
      .mockImplementation((fn: (provider: unknown) => unknown) => fn({})),
    getProvider: vi.fn().mockReturnValue({}),
  }),
}));

// Settable mock for aggregate3.staticCall.
// Sibling test files reassign via `mockAggregate3StaticCall.mockResolvedValueOnce(...)`.
// biome-ignore lint/suspicious/noExportsInTest: intentional shared test helper
export const mockAggregate3StaticCall = vi.fn();

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

// ─── Shared ABI fragment ─────────────────────────────────────────────────────

// Flat-return getUserAccountData — safe to decode with ethers v6.
// Do NOT use PoolDataProvider's getReserveData (nested-tuple decode bug).
// biome-ignore lint/suspicious/noExportsInTest: intentional shared test helper
export const AAVE_V3_POOL_ABI_FRAGMENT = [
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

// ─── Shared encode helper ─────────────────────────────────────────────────────

interface AccountData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  /** Raw health factor in WAD (1e18 = 1.0). Use BigInt(2)**BigInt(256) - 1n for MAX_UINT256. */
  healthFactor: bigint;
}

// Lazy-initialised to avoid top-level import of mocked ethers before mock hoisting.
let _poolIface: import("ethers").Interface | null = null;

function getPoolIface(): import("ethers").Interface {
  if (_poolIface === null) {
    // Require at call-time so the vi.mock("ethers") hoisting has already run.
    const { ethers } = require("ethers") as typeof import("ethers");
    _poolIface = new ethers.Interface(AAVE_V3_POOL_ABI_FRAGMENT);
  }
  return _poolIface;
}

/**
 * Encode a getUserAccountData return value using the real ethers Interface so
 * the ABI encoding matches what an on-chain contract would return.
 *
 * Returns a `[success, returnData]` tuple ready to splice into a mocked
 * aggregate3.staticCall result array.
 *
 * Use `BigInt(2) ** BigInt(256) - BigInt(1)` for the MAX_UINT256 health factor
 * (tsconfig targets ES2017; bigint literals with `n` suffix require ES2020).
 *
 * @param overrides Fields to override from healthy-loan defaults.
 */
// biome-ignore lint/suspicious/noExportsInTest: intentional shared test helper
export function encodeAccountData(
  overrides: Partial<AccountData>
): [boolean, string] {
  const defaults: AccountData = {
    totalCollateralBase: BigInt(1000),
    totalDebtBase: BigInt(500),
    availableBorrowsBase: BigInt(0),
    currentLiquidationThreshold: BigInt(8000),
    ltv: BigInt(7500),
    healthFactor: BigInt("2000000000000000000"), // 2.0 WAD
  };
  const d = { ...defaults, ...overrides };
  const returnData = getPoolIface().encodeFunctionResult("getUserAccountData", [
    d.totalCollateralBase,
    d.totalDebtBase,
    d.availableBorrowsBase,
    d.currentLiquidationThreshold,
    d.ltv,
    d.healthFactor,
  ]);
  return [true, returnData];
}

// ─── Guard todos ─────────────────────────────────────────────────────────────

describe("scanner correctness guards", () => {
  it.todo(
    "HF MAX_UINT256 or zero-debt -> healthFactor null + noActiveLoan true"
  );

  it.todo("Multicall3 soft-miss -> one failed sub-call leaves siblings intact");

  it.todo(
    "EIP-1967 proxy ABI -> impl slot resolves real implementation address"
  );

  it.todo(
    "partial chain -> slow/failed chain yields unavailableChains[], not 500"
  );
});
