/**
 * Superfluid On-Chain Integration Tests
 *
 * Verifies that the Superfluid protocol definition produces valid calldata
 * the deployed CFA and GDA forwarders accept on Sepolia. Catches contract
 * dispatch and ABI-shape mistakes the unit-test layer cannot see.
 *
 * Gated on INTEGRATION_TEST_RPC_URL env var - skipped in CI without it.
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import superfluidDef from "@/protocols/superfluid";

const RPC_URL = process.env.INTEGRATION_TEST_RPC_URL;
const CHAIN_ID = "11155111";
const SEPOLIA_CHAIN_ID = 11_155_111;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
// fUSDCx on Sepolia. The forwarders validate the token argument against the
// Superfluid host registry and revert for unknown addresses, so reads need a
// real SuperToken. fUSDCx is the canonical Sepolia test token; an account
// with no flows returns 0, which is exactly what we want to assert decoding.
const SEPOLIA_FUSDCX = "0xb598E6C621618a9f63788816ffb50Ee2862D443B";

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
  // Reproduce the production pipeline: reshape flat args into tuples per ABI,
  // then coerce stringly-typed leaves (bool "false" -> false) before encoding.
  const reshaped = reshapeArgsForAbi(rawArgs, functionAbi);
  const args = coerceArgsForAbi(reshaped, functionAbi);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(action.function, args);

  return { to: contractAddress, data, action, contract };
}

describe.skipIf(!RPC_URL)("Superfluid on-chain integration", () => {
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

  it("get-flow: eth_call returns the four expected CFA flow-info outputs", async () => {
    const { to, data, contract } = buildCalldata(superfluidDef, "get-flow", {
      token: SEPOLIA_FUSDCX,
      sender: TEST_ADDRESS,
      receiver: TEST_ADDRESS,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );

    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getFlowInfo", result);
    expect(decoded).toBeDefined();
    expect(decoded).toHaveLength(4);
  }, 15_000);

  it("get-cfa-net-flow: dispatches to cfaForwarder.getAccountFlowrate", async () => {
    const { to, data, contract } = buildCalldata(
      superfluidDef,
      "get-cfa-net-flow",
      {
        token: SEPOLIA_FUSDCX,
        account: TEST_ADDRESS,
      }
    );

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );

    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getAccountFlowrate", result);
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("get-net-flow: dispatches to gdaForwarder.getNetFlow", async () => {
    const { to, data, contract } = buildCalldata(
      superfluidDef,
      "get-net-flow",
      {
        token: SEPOLIA_FUSDCX,
        account: TEST_ADDRESS,
      }
    );

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );

    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("getNetFlow", result);
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("create-pool: flat bool inputs reshape into a tuple the GDA forwarder accepts", async () => {
    const { to, data } = buildCalldata(superfluidDef, "create-pool", {
      token: SEPOLIA_FUSDCX,
      admin: TEST_ADDRESS,
      transferabilityForUnitsOwner: "false",
      distributionFromAnyAddress: "false",
    });

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
