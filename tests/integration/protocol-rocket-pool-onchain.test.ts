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
 * Uses INTEGRATION_TEST_MAINNET_RPC_URL because Rocket Pool is deployed
 * on Ethereum mainnet only - the Sepolia-targeted INTEGRATION_TEST_RPC_URL
 * would produce address mismatches.
 *
 * Gated on INTEGRATION_TEST_MAINNET_RPC_URL - skipped in CI without it.
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { reshapeArgsForAbi } from "@/lib/abi/struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import rocketPoolDef from "@/protocols/rocket-pool";

const RPC_URL = process.env.INTEGRATION_TEST_MAINNET_RPC_URL;
const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";

function buildCalldata(
  protocol: ProtocolDefinition,
  actionSlug: string,
  sampleInputs: Record<string, string>
): {
  to: string;
  data: string;
  action: ProtocolAction;
  contract: ProtocolContract;
} {
  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    throw new Error(`Action ${actionSlug} not found`);
  }

  const contract = protocol.contracts[action.contract];
  if (!contract.abi) {
    throw new Error(`Contract ${action.contract} has no ABI`);
  }

  const contractAddress = contract.addresses[CHAIN_ID];
  if (!contractAddress) {
    throw new Error(`Contract ${action.contract} not on chain ${CHAIN_ID}`);
  }

  const rawArgs = action.inputs.map((inp) => {
    const val = sampleInputs[inp.name] ?? inp.default ?? "";
    return val;
  });

  const abi = JSON.parse(contract.abi);
  const functionAbi = abi.find(
    (f: { name: string; type: string }) =>
      f.type === "function" && f.name === action.function
  );
  const args = reshapeArgsForAbi(rawArgs, functionAbi);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(action.function, args);

  return { to: contractAddress, data, action, contract };
}

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
describe.skipIf(!RPC_URL)("Rocket Pool on-chain integration", () => {
  // Route every RPC call through the failover manager so a primary-endpoint
  // hiccup falls back to the secondary instead of failing the test.
  let manager: RpcProviderManager;

  beforeAll(async () => {
    if (!RPC_URL) {
      return;
    }
    manager = await getRpcProviderFromUrls(
      RPC_URL,
      getRpcUrlByChainId(MAINNET_CHAIN_ID, "fallback"),
      MAINNET_CHAIN_ID,
      "ethereum"
    );
  });

  it("getExchangeRate: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata(
      rocketPoolDef,
      "get-exchange-rate",
      {}
    );

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
    const { to, data, contract } = buildCalldata(
      rocketPoolDef,
      "balance-of",
      { account: TEST_ADDRESS }
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

  it("totalSupply: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata(
      rocketPoolDef,
      "total-supply",
      {}
    );

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
    const { to, data, contract } = buildCalldata(
      rocketPoolDef,
      "get-total-collateral",
      {}
    );

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
    const { to, data } = buildCalldata(rocketPoolDef, "deposit", {});

    await expectCallAcceptedByBytecode(manager, { to, data });
  }, 15_000);

  it("burn: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata(rocketPoolDef, "burn", {
      amount: "1000000000000000000",
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
