/**
 * Uniswap V3 On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Uniswap V3 protocol definition produces
 * calldata that real Sepolia Uniswap V3 contracts accept.
 *
 * RPC URL resolution (shared with the rest of the codebase):
 *   1. CHAIN_RPC_CONFIG JSON (Helm/AWS Parameter Store, set in CI + deployed
 *      environments)
 *   2. Individual CHAIN_SEPOLIA_*_RPC env vars (dev override)
 *   3. Public Sepolia RPC default (last resort)
 *
 * Uses getRpcProviderFromUrls + executeWithFailover so primary RPC failures
 * transparently fail over to the fallback URL - same failover machinery
 * deployed services use.
 *
 * Ungated. Always runs. Public RPC backs every tier so the test is never
 * blocked by missing env vars. CI uses the paid staging endpoints via
 * CHAIN_RPC_CONFIG.
 *
 * Test philosophy: verify derived calldata is valid ABI, not that business
 * operations succeed. Pools may lack liquidity on Sepolia and position
 * token IDs may not exist; the try/catch paths accept those reverts as
 * long as the error is not an ABI encoding failure.
 */

import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { reshapeArgsForAbi } from "@/lib/abi-struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";
import uniswapDef from "@/protocols/uniswap-v3";

const CHAIN_ID = "11155111"; // Sepolia
const CHAIN_ID_NUMBER = 11_155_111;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

// Sepolia token addresses used for read-path tests. The WETH/USDC 0.3% pool
// has had liquidity historically; if it lacks liquidity at test time the
// quote calls revert with a business error and the try/catch still asserts
// the calldata was well-formed.
const SEPOLIA_WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const FEE_TIER_030 = "3000";
const ONE_ETH = "1000000000000000000";

// Resolve Sepolia RPC URLs via the shared config pipeline: CHAIN_RPC_CONFIG
// first, individual env vars second, public default last.
const rpcConfig = parseRpcConfig(process.env.CHAIN_RPC_CONFIG);
const resolveRpcUrl = createRpcUrlResolver(rpcConfig);
const SEPOLIA_PRIMARY_URL = resolveRpcUrl(
  "eth-sepolia",
  "CHAIN_SEPOLIA_PRIMARY_RPC",
  PUBLIC_RPCS.SEPOLIA,
  "primary"
);
const SEPOLIA_FALLBACK_URL = resolveRpcUrl(
  "eth-sepolia",
  "CHAIN_SEPOLIA_FALLBACK_RPC",
  PUBLIC_RPCS.SEPOLIA,
  "fallback"
);

type Calldata = {
  to: string;
  data: string;
  action: ProtocolAction;
  contract: ProtocolContract;
};

// Builds calldata from a protocol action. For contracts with
// userSpecifiedAddress: true, pass `toOverride` so the request targets a
// real runtime token address rather than the reference address baked into
// the protocol definition. (Uniswap V3 has no userSpecifiedAddress
// contracts today, but the hook is preserved to match the CCIP helper.)
function buildCalldata(
  protocol: ProtocolDefinition,
  actionSlug: string,
  sampleInputs: Record<string, string>,
  toOverride?: string
): Calldata {
  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    throw new Error(`Action ${actionSlug} not found`);
  }

  const contract = protocol.contracts[action.contract];
  if (!contract.abi) {
    throw new Error(`Contract ${action.contract} has no ABI`);
  }

  const to = toOverride ?? contract.addresses[CHAIN_ID];
  if (!to) {
    throw new Error(
      `No address for contract ${action.contract} on chain ${CHAIN_ID}`
    );
  }

  const rawArgs = action.inputs.map(
    (inp) => sampleInputs[inp.name] ?? inp.default ?? ""
  );

  const abi = JSON.parse(contract.abi);
  const functionAbi = abi.find(
    (f: { name: string; type: string }) =>
      f.type === "function" && f.name === action.function
  );
  const args = reshapeArgsForAbi(rawArgs, functionAbi);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(action.function, args);

  return { to, data, action, contract };
}

describe("Uniswap V3 on-chain integration (Sepolia)", () => {
  const makeProvider = () =>
    getRpcProviderFromUrls(
      SEPOLIA_PRIMARY_URL,
      SEPOLIA_FALLBACK_URL,
      CHAIN_ID_NUMBER,
      "Sepolia (Uniswap V3 integration test)"
    );

  // -- factory ---------------------------------------------------------------

  it("get-pool: eth_call returns a decodable address", async () => {
    const { to, data, contract } = buildCalldata(uniswapDef, "get-pool", {
      tokenA: SEPOLIA_WETH,
      tokenB: SEPOLIA_USDC,
      fee: FEE_TIER_030,
    });

    const provider = await makeProvider();
    const result = await provider.executeWithFailover(
      async (p) => await p.call({ to, data })
    );
    const iface = new ethers.Interface(JSON.parse(contract.abi as string));
    const decoded = iface.decodeFunctionResult("getPool", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("string");
    expect(decoded[0]).toMatch(HEX_ADDRESS_REGEX);
  }, 30_000);

  // -- positionManager -------------------------------------------------------

  it("balance-of: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata(uniswapDef, "balance-of", {
      owner: TEST_ADDRESS,
    });

    const provider = await makeProvider();
    const result = await provider.executeWithFailover(
      async (p) => await p.call({ to, data })
    );
    const iface = new ethers.Interface(JSON.parse(contract.abi as string));
    const decoded = iface.decodeFunctionResult("balanceOf", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 30_000);

  it("owner-of: calldata encodes (business revert expected for invalid tokenId)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "owner-of", {
      tokenId: "1",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  it("get-position: calldata encodes (business revert expected for invalid tokenId)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "get-position", {
      tokenId: "1",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  it("approve-position: estimateGas calldata is valid (business revert expected)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "approve-position", {
      to: TEST_ADDRESS,
      tokenId: "1",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  it("transfer-position: estimateGas calldata is valid (business revert expected)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "transfer-position", {
      from: TEST_ADDRESS,
      to: TEST_ADDRESS,
      tokenId: "1",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  it("burn-position: estimateGas calldata is valid (business revert expected)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "burn-position", {
      tokenId: "1",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  // -- quoter (tuple-flattened inputs) ---------------------------------------

  it("quote-exact-input: calldata encodes (business revert OK if pool lacks liquidity)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "quote-exact-input", {
      tokenIn: SEPOLIA_WETH,
      tokenOut: SEPOLIA_USDC,
      amountIn: ONE_ETH,
      fee: FEE_TIER_030,
      sqrtPriceLimitX96: "0",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  it("quote-exact-output: calldata encodes (business revert OK if pool lacks liquidity)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "quote-exact-output", {
      tokenIn: SEPOLIA_WETH,
      tokenOut: SEPOLIA_USDC,
      amount: ONE_ETH,
      fee: FEE_TIER_030,
      sqrtPriceLimitX96: "0",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  // -- swapRouter (tuple-flattened inputs) -----------------------------------

  it("swap-exact-input: estimateGas calldata is valid (business revert expected - no approval)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "swap-exact-input", {
      tokenIn: SEPOLIA_WETH,
      tokenOut: SEPOLIA_USDC,
      fee: FEE_TIER_030,
      recipient: TEST_ADDRESS,
      amountIn: ONE_ETH,
      amountOutMinimum: "0",
      sqrtPriceLimitX96: "0",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);

  it("swap-exact-output: estimateGas calldata is valid (business revert expected - no approval)", async () => {
    const { to, data } = buildCalldata(uniswapDef, "swap-exact-output", {
      tokenIn: SEPOLIA_WETH,
      tokenOut: SEPOLIA_USDC,
      fee: FEE_TIER_030,
      recipient: TEST_ADDRESS,
      amountOut: ONE_ETH,
      amountInMaximum: ONE_ETH,
      sqrtPriceLimitX96: "0",
    });

    const provider = await makeProvider();
    try {
      await provider.executeWithFailover(
        async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
      );
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 30_000);
});
