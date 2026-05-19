/**
 * Wrapped On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Wrapped protocol definition produces valid
 * calldata that real contracts accept. Runs against a live RPC endpoint.
 *
 * Gated on INTEGRATION_TEST_RPC_URL env var - skipped in CI without it.
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import wrappedDef from "@/protocols/wrapped";
import { buildCalldata } from "./_shared/build-calldata";

const RPC_URL = process.env.INTEGRATION_TEST_RPC_URL;
const CHAIN_ID = "11155111";
const SEPOLIA_CHAIN_ID = 11_155_111;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";

describe.skipIf(!RPC_URL)("Wrapped on-chain integration", () => {
  // Route every RPC call through the failover manager so a primary-endpoint
  // hiccup falls back to the secondary instead of failing the test. The
  // primary URL respects INTEGRATION_TEST_RPC_URL (the original gate); the
  // fallback comes from the same chains-config used in production.
  let manager: RpcProviderManager;

  beforeAll(async () => {
    if (!RPC_URL) {
      return;
    }
    manager = await getRpcProviderFromUrls(
      RPC_URL,
      getRpcUrlByChainId(SEPOLIA_CHAIN_ID, "fallback"),
      SEPOLIA_CHAIN_ID,
      "sepolia"
    );
  });

  it("balanceOf: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata(
      wrappedDef,
      "balance-of",
      { account: TEST_ADDRESS },
      { chainId: CHAIN_ID }
    );

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );

    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("balanceOf", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("deposit: estimateGas succeeds with ETH value", async () => {
    const { to, data } = buildCalldata(
      wrappedDef,
      "wrap",
      {},
      { chainId: CHAIN_ID }
    );

    const gas = await manager.executeWithFailover((p) =>
      p.estimateGas({
        to,
        data,
        value: ethers.parseEther("0.001"),
        from: TEST_ADDRESS,
      })
    );

    expect(gas).toBeGreaterThan(BigInt(0));
  }, 15_000);

  it("withdraw: calldata encodes correctly (business revert expected)", async () => {
    const { to, data } = buildCalldata(
      wrappedDef,
      "unwrap",
      { wad: "1000000000000000000" },
      { chainId: CHAIN_ID }
    );

    try {
      await manager.executeWithFailover((p) =>
        p.estimateGas({
          to,
          data,
          from: TEST_ADDRESS,
        })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 15_000);
});
