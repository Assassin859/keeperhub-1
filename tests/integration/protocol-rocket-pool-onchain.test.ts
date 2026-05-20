/**
 * Rocket Pool On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Rocket Pool protocol definition produces
 * calldata the deployed rETH and Rocket Deposit Pool contracts accept on
 * Ethereum mainnet. Catches contract dispatch and ABI-shape mistakes the
 * unit-test layer cannot see.
 *
 * Coverage: every action declared by the protocol gets at least one
 * dispatch test (read decodes, write encodes without ABI errors).
 *
 * RPC URL resolution (shared with the rest of the codebase):
 *   1. CHAIN_RPC_CONFIG JSON (Helm/AWS Parameter Store, set in CI + deployed
 *      environments)
 *   2. Individual CHAIN_ETH_MAINNET_*_RPC env vars (dev override)
 *   3. Public Ethereum mainnet RPC default (last resort)
 *
 * Ungated. Always runs. Public RPC backs every tier so the test is never
 * blocked by missing env vars. CI uses the paid staging endpoints via
 * CHAIN_RPC_CONFIG.
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";
import rocketPoolDef from "@/protocols/rocket-pool";
import { buildCalldata } from "./_shared/build-calldata";

const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";

// Resolve Ethereum mainnet RPC URLs via the shared config pipeline:
// CHAIN_RPC_CONFIG first, individual env vars second, public default last.
const rpcConfig = parseRpcConfig(process.env.CHAIN_RPC_CONFIG);
const resolveRpcUrl = createRpcUrlResolver(rpcConfig);
const MAINNET_PRIMARY_URL = resolveRpcUrl(
  "eth-mainnet",
  "CHAIN_ETH_MAINNET_PRIMARY_RPC",
  PUBLIC_RPCS.ETH_MAINNET,
  "primary"
);
const MAINNET_FALLBACK_URL = resolveRpcUrl(
  "eth-mainnet",
  "CHAIN_ETH_MAINNET_FALLBACK_RPC",
  PUBLIC_RPCS.ETH_MAINNET_FALLBACK,
  "fallback"
);

// Assertion model:
//  - Read tests: let the RPC call fail loudly. A success path asserts the
//    decoded return has the expected shape; anything else (network error,
//    ABI mismatch, decode failure) surfaces as a real test failure instead
//    of being swallowed.
//  - Write tests: use provider.call against a zero-balance TEST_ADDRESS.
//    The contract should either (a) revert with CALL_EXCEPTION on business
//    logic (insufficient balance for burn, deposit pool not accepting
//    deposits at zero msg.value, etc.), or (b) succeed and return "0x" for
//    void functions. Both outcomes prove the deployed bytecode understood
//    the calldata. What we reject: calldata-level ethers errors
//    (INVALID_ARGUMENT, BAD_DATA, BUFFER_OVERRUN) which would indicate the
//    ABI doesn't match the deployed contract.
describe("Rocket Pool on-chain integration", () => {
  // Route every RPC call through the failover manager so a primary-endpoint
  // hiccup falls back to the secondary instead of failing the test.
  let manager: RpcProviderManager;

  beforeAll(async () => {
    manager = await getRpcProviderFromUrls(
      MAINNET_PRIMARY_URL,
      MAINNET_FALLBACK_URL,
      MAINNET_CHAIN_ID,
      "ethereum"
    );
  });

  it("getExchangeRate: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: rocketPoolDef,
      actionSlug: "get-exchange-rate",
      sampleInputs: {},
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getExchangeRate", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("balanceOf: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: rocketPoolDef,
      actionSlug: "balance-of",
      sampleInputs: { account: TEST_ADDRESS },
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("balanceOf", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("totalSupply: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: rocketPoolDef,
      actionSlug: "total-supply",
      sampleInputs: {},
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("totalSupply", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("getTotalCollateral: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata({
      protocol: rocketPoolDef,
      actionSlug: "get-total-collateral",
      sampleInputs: {},
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getTotalCollateral", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("deposit: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata({
      protocol: rocketPoolDef,
      actionSlug: "deposit",
      sampleInputs: {},
      chainId: CHAIN_ID,
    });

    await expectCallAcceptedByBytecode(manager, { to, data });
  }, 15_000);

  it("burn: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata({
      protocol: rocketPoolDef,
      actionSlug: "burn",
      sampleInputs: { amount: "1000000000000000000" },
      chainId: CHAIN_ID,
    });

    await expectCallAcceptedByBytecode(manager, { to, data });
  }, 15_000);
});

/**
 * Asserts the deployed bytecode accepted our calldata: either the call
 * returned cleanly (void functions return "0x") or reverted at the contract
 * level (CALL_EXCEPTION). Any other error class means the ABI doesn't match
 * what's deployed. The call is routed through the failover manager so a
 * primary-RPC hiccup falls to the secondary endpoint.
 */
async function expectCallAcceptedByBytecode(
  manager: RpcProviderManager,
  tx: { to: string; data: string }
): Promise<void> {
  try {
    const result = await manager.executeWithFailover((p) =>
      p.call({ ...tx, from: TEST_ADDRESS })
    );
    expect(result).toMatch(/^0x/);
  } catch (err: unknown) {
    expect(err).toMatchObject({ code: "CALL_EXCEPTION" });
  }
}
