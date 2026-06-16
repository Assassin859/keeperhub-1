/**
 * Scan adapter unit tests — Lido staking adapter (SCAN-04) and
 * stablecoin balance adapter (SCAN-02).
 *
 * Both adapters encode ERC20 balanceOf calls for Multicall3 aggregate3
 * batching. A failed sub-call (success: false) is a soft miss — it drops
 * only that token and does not throw.
 *
 * TDD: tests were written first (RED), implementation added after (GREEN).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ethers } from "ethers";
import { buildLidoCalls, decodeLidoResults } from "@/lib/scan/adapters/lido";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** ABI-encode a uint256 as ERC20 balanceOf return data. */
function encodeBalance(amount: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [amount]);
}

const TEST_USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// ─── Lido adapter ─────────────────────────────────────────────────────────────

describe("lido adapter", () => {
  it("lido: Ethereum (chainId 1) builds 2 balanceOf calls — stETH and wstETH", () => {
    const calls = buildLidoCalls(TEST_USER, 1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.allowFailure).toBe(true);
    expect(calls[1]?.allowFailure).toBe(true);
  });

  it("lido: Arbitrum (chainId 42161) builds 1 balanceOf call — wstETH only", () => {
    const calls = buildLidoCalls(TEST_USER, 42161);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.allowFailure).toBe(true);
  });

  it("lido: chainId 1 decode emits 2 suppliedAssets with stringified bigint amounts", () => {
    const stEthBalance = BigInt("500000000000000000"); // 0.5 stETH in wei
    const wstEthBalance = BigInt("300000000000000000"); // 0.3 wstETH in wei

    const results = [
      { success: true, returnData: encodeBalance(stEthBalance) },
      { success: true, returnData: encodeBalance(wstEthBalance) },
    ];

    const positions = decodeLidoResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.protocol).toBe("lido");
    expect(pos?.chainId).toBe(1);
    expect(pos?.suppliedAssets).toHaveLength(2);
    expect(pos?.borrowedAssets).toHaveLength(0);
    expect(pos?.healthFactor).toBeNull();
    expect(pos?.totalCollateralUsd).toBeNull();
    expect(pos?.totalDebtUsd).toBeNull();

    const [stAsset, wstAsset] = pos?.suppliedAssets ?? [];
    expect(stAsset?.symbol).toBe("stETH");
    expect(stAsset?.amount).toBe(String(stEthBalance));
    expect(stAsset?.decimals).toBe(18);
    expect(stAsset?.usdValue).toBeNull();

    expect(wstAsset?.symbol).toBe("wstETH");
    expect(wstAsset?.amount).toBe(String(wstEthBalance));
    expect(wstAsset?.decimals).toBe(18);
    expect(wstAsset?.usdValue).toBeNull();
  });

  it("lido: chainId 42161 decode emits 1 wstETH asset (raw balance, no conversion call)", () => {
    const wstEthBalance = BigInt("200000000000000000"); // 0.2 wstETH

    const results = [{ success: true, returnData: encodeBalance(wstEthBalance) }];

    const positions = decodeLidoResults(results, TEST_USER, 42161);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.suppliedAssets).toHaveLength(1);
    expect(pos?.suppliedAssets[0]?.symbol).toBe("wstETH");
    expect(pos?.suppliedAssets[0]?.amount).toBe(String(wstEthBalance));
    expect(pos?.suppliedAssets[0]?.decimals).toBe(18);
  });

  it("lido: failed sub-call (success: false) skips that token, does not drop others", () => {
    // stETH call fails; wstETH call succeeds.
    const wstEthBalance = BigInt("100000000000000000"); // 0.1 wstETH
    const results = [
      { success: false, returnData: "0x" },
      { success: true, returnData: encodeBalance(wstEthBalance) },
    ];

    const positions = decodeLidoResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.suppliedAssets).toHaveLength(1);
    expect(pos?.suppliedAssets[0]?.symbol).toBe("wstETH");
    expect(pos?.suppliedAssets[0]?.amount).toBe(String(wstEthBalance));
  });

  it("lido: returns empty array when all balances are zero or failed", () => {
    const results = [
      { success: true, returnData: encodeBalance(BigInt(0)) },
      { success: true, returnData: encodeBalance(BigInt(0)) },
    ];
    expect(decodeLidoResults(results, TEST_USER, 1)).toHaveLength(0);
  });

  it("lido: returns empty array for unsupported chainId", () => {
    const results = [{ success: true, returnData: encodeBalance(BigInt("1000")) }];
    expect(decodeLidoResults(results, TEST_USER, 99)).toHaveLength(0);
  });
});
