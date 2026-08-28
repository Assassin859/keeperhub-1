import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockContract = vi.fn();
vi.mock("ethers", () => ({
  ethers: {
    Contract: class {
      uiMultiplier: () => Promise<bigint>;
      constructor(address: string) {
        this.uiMultiplier = () => mockContract(address);
      }
    },
  },
}));

import {
  __clearUiMultiplierCache,
  getUiMultiplier,
  isScaledToken,
  rawToUi,
  UI_MULTIPLIER_UNIT,
  uiToRaw,
} from "@/lib/web3/ui-multiplier";

const CRWD = "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const FOUR = BigInt(4) * UI_MULTIPLIER_UNIT;

// Runner that just hands the operation a stub provider.
const run = <T>(op: (p: never) => Promise<T>): Promise<T> =>
  op(undefined as never);

beforeEach(() => {
  __clearUiMultiplierCache();
  mockContract.mockReset();
});

describe("conversions", () => {
  it("is the identity at unit multiplier", () => {
    expect(rawToUi(BigInt(123), UI_MULTIPLIER_UNIT)).toBe(BigInt(123));
    expect(uiToRaw(BigInt(123), UI_MULTIPLIER_UNIT)).toBe(BigInt(123));
    expect(isScaledToken(UI_MULTIPLIER_UNIT)).toBe(false);
  });

  it("scales a real CRWD position the way the chain reports it", () => {
    // Measured on chain: balanceOf 7.572731046613574564,
    // balanceOfUI 30.290924186454298256, exactly 4x.
    const raw = BigInt("7572731046613574564");
    expect(rawToUi(raw, FOUR)).toBe(BigInt("30290924186454298256"));
    expect(isScaledToken(FOUR)).toBe(true);
  });

  it("converts a typed amount down, not up: the over-send bug", () => {
    // A user asking for 10 CRWD means 10 of what Robinhood shows them.
    // Before the fix this passed 10e18 straight to transfer, moving 40.
    const tenUi = BigInt(10) * UI_MULTIPLIER_UNIT;
    expect(uiToRaw(tenUi, FOUR)).toBe(BigInt("2500000000000000000")); // 2.5e18
    expect(rawToUi(uiToRaw(tenUi, FOUR), FOUR)).toBe(tenUi);
  });

  it("floors rather than rounds up, so a transfer never exceeds the ask", () => {
    // AAPL's live multiplier, which does not divide evenly.
    const aapl = BigInt("1000566080061092436");
    const tenUi = BigInt(10) * UI_MULTIPLIER_UNIT;
    const raw = uiToRaw(tenUi, aapl);
    expect(raw).toBeLessThan(tenUi);
    // Round-tripping never gives back more than was asked for.
    expect(rawToUi(raw, aapl)).toBeLessThanOrEqual(tenUi);
  });
});

describe("getUiMultiplier", () => {
  it("returns the on-chain multiplier for an ERC-8056 token", async () => {
    mockContract.mockResolvedValue(FOUR);
    await expect(getUiMultiplier(run, 4663, CRWD)).resolves.toBe(FOUR);
  });

  it("falls back to unit when the call reverts, as on a plain ERC-20", async () => {
    mockContract.mockRejectedValue(new Error("execution reverted"));
    await expect(getUiMultiplier(run, 4663, USDG)).resolves.toBe(
      UI_MULTIPLIER_UNIT
    );
  });

  it("treats a zero multiplier as not-ERC-8056 rather than zeroing balances", async () => {
    mockContract.mockResolvedValue(BigInt(0));
    await expect(getUiMultiplier(run, 4663, CRWD)).resolves.toBe(
      UI_MULTIPLIER_UNIT
    );
  });

  it("caches the revert so a plain ERC-20 pays for one failed call, not one per read", async () => {
    mockContract.mockRejectedValue(new Error("execution reverted"));
    await getUiMultiplier(run, 4663, USDG);
    await getUiMultiplier(run, 4663, USDG);
    await getUiMultiplier(run, 4663, USDG);
    expect(mockContract).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by chain as well as address", async () => {
    mockContract.mockResolvedValue(FOUR);
    await getUiMultiplier(run, 4663, CRWD);
    await getUiMultiplier(run, 1, CRWD);
    expect(mockContract).toHaveBeenCalledTimes(2);
  });

  it("never throws, so a multiplier read cannot fail an otherwise valid transfer", async () => {
    mockContract.mockRejectedValue(new Error("boom"));
    await expect(getUiMultiplier(run, 4663, CRWD)).resolves.toBe(
      UI_MULTIPLIER_UNIT
    );
  });
});
