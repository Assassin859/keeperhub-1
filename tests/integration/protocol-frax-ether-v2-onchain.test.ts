/**
 * Frax Ether V2 On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Frax Ether V2 protocol definition produces
 * calldata that the deployed V2 minter contract accepts on Ethereum
 * mainnet. Catches contract dispatch and ABI-shape mistakes the unit-test
 * layer cannot see.
 *
 * Coverage: every action declared by the protocol gets at least one
 * dispatch test (the read decodes, the writes encode without ABI errors).
 *
 * Uses INTEGRATION_TEST_MAINNET_RPC_URL because Frax Ether V2 is deployed
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
import fraxEtherV2Def from "@/protocols/frax-ether-v2";

const RPC_URL = process.env.INTEGRATION_TEST_MAINNET_RPC_URL;
const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const TX_RESULT_HEX_PREFIX = /^0x/;

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
//  - Read tests: let the RPC call surface failures. A success path decodes
//    the return; anything else (network error, ABI mismatch, decode
//    failure) surfaces as a real test failure.
//  - Write tests: use provider.call (not estimateGas) against a
//    zero-balance TEST_ADDRESS. The contract should either (a) revert
//    with CALL_EXCEPTION on business logic (e.g. "msg.value must be > 0"
//    on mintFrxEth with no value, or recipient validation), or (b)
//    succeed and return "0x" for void functions. Both outcomes prove the
//    deployed bytecode parsed our calldata. What we reject: calldata-level
//    ethers errors (INVALID_ARGUMENT, BAD_DATA, BUFFER_OVERRUN) which
//    would indicate the V1/V2 ABI confusion this protocol entry is
//    designed to avoid.
describe.skipIf(!RPC_URL)("Frax Ether V2 minter on-chain integration", () => {
  // Route every RPC call through the failover manager so a primary-endpoint
  // hiccup falls back to the secondary instead of failing the test. The
  // primary URL respects INTEGRATION_TEST_MAINNET_RPC_URL (the original
  // gate); the fallback comes from the chains-config used in production.
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

  /**
   * Simulates an eth_call against the deployed bytecode and resolves
   * cleanly if the calldata was accepted: either the call returned hex
   * data (void functions return "0x") or reverted with CALL_EXCEPTION at
   * the contract level (an acceptable business revert). Any other error
   * class is rethrown so the test fails; that signals an ABI/bytecode
   * mismatch. The call is routed through the failover manager (closed
   * over from describe scope) so a primary-RPC hiccup falls back to the
   * secondary endpoint.
   *
   * Throws-instead-of-asserts so the helper does not contain expect()
   * calls outside an it() block. Call sites use
   * `await expect(simulateBytecodeCall(...)).resolves.toBeUndefined()`.
   */
  async function simulateBytecodeCall(tx: {
    to: string;
    data: string;
  }): Promise<void> {
    try {
      const result = await manager.executeWithFailover((p) =>
        p.call({ ...tx, from: TEST_ADDRESS })
      );
      if (!TX_RESULT_HEX_PREFIX.test(result)) {
        throw new Error(
          `Expected hex-prefixed return from eth_call, got: ${result}`
        );
      }
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "CALL_EXCEPTION"
      ) {
        return;
      }
      throw err;
    }
  }

  it("mintFrxEthPaused: eth_call returns a decodable bool", async () => {
    const { to, data, contract } = buildCalldata(
      fraxEtherV2Def,
      "mint-paused",
      {}
    );

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );

    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("mintFrxEthPaused", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("boolean");
  }, 15_000);

  it("mintFrxEth: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata(fraxEtherV2Def, "mint", {});

    await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
  }, 15_000);

  it("mintFrxEthAndGive: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata(fraxEtherV2Def, "mint-and-give", {
      recipient: TEST_ADDRESS,
    });

    await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
  }, 15_000);

  it("submitAndDeposit: deployed bytecode accepts the calldata", async () => {
    const { to, data } = buildCalldata(fraxEtherV2Def, "mint-and-stake", {
      recipient: TEST_ADDRESS,
    });

    await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
  }, 15_000);
});
