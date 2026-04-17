/**
 * Wrapped On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Wrapped protocol definition produces valid
 * calldata that real contracts accept. Runs against a live RPC endpoint.
 *
 * Gated on INTEGRATION_TEST_RPC_URL env var - skipped in CI without it.
 */

import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { reshapeArgsForAbi } from "@/lib/abi-struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import wrappedDef from "@/protocols/wrapped";

const RPC_URL = process.env.INTEGRATION_TEST_RPC_URL;
const CHAIN_ID = "11155111";
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

describe.skipIf(!RPC_URL)("Wrapped on-chain integration", () => {
  const getProvider = (): ethers.JsonRpcProvider =>
    new ethers.JsonRpcProvider(RPC_URL);

  it("balanceOf: eth_call returns a decodable uint256", async () => {
    const { to, data, contract } = buildCalldata(wrappedDef, "balance-of", {
      account: TEST_ADDRESS,
    });

    const provider = getProvider();
    const result = await provider.call({ to, data });

    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult("balanceOf", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("deposit: estimateGas succeeds with ETH value", async () => {
    const { to, data } = buildCalldata(wrappedDef, "wrap", {});

    const provider = getProvider();
    const gas = await provider.estimateGas({
      to,
      data,
      value: ethers.parseEther("0.001"),
      from: TEST_ADDRESS,
    });

    expect(gas).toBeGreaterThan(BigInt(0));
  }, 15_000);

  it("withdraw: calldata encodes correctly (business revert expected)", async () => {
    const { to, data } = buildCalldata(wrappedDef, "unwrap", {
      wad: "1000000000000000000",
    });

    const provider = getProvider();
    try {
      await provider.estimateGas({
        to,
        data,
        from: TEST_ADDRESS,
      });
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
      expect(msg).not.toContain("invalid function");
    }
  }, 15_000);
});
