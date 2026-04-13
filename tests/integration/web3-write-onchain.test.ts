/**
 * Web3 Write-Contract On-Chain Integration Tests
 *
 * Verifies that the web3 write-contract path (raw ABI + function name + args)
 * produces valid calldata against real contracts. Tests the same pipeline
 * users hit: ABI JSON -> function selection -> args as JSON array ->
 * reshapeArgsForAbi -> validateArgsForAbi -> ethers.encodeFunctionData.
 *
 * Uses WETH on Sepolia as the test contract (stable, well-known ABI).
 * Gated on INTEGRATION_TEST_RPC_URL env var.
 */

import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { reshapeArgsForAbi } from "@/lib/abi-struct-args";
import { validateArgsForAbi } from "@/lib/abi-validate-args";

const RPC_URL = process.env.INTEGRATION_TEST_RPC_URL;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";

const WETH_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

const WETH_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "guy", type: "address" },
      { name: "wad", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dst", type: "address" },
      { name: "wad", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
];

/**
 * Simulate the web3 write-contract path: JSON ABI string -> find function ->
 * parse args from JSON array -> reshape -> validate -> encode.
 */
function buildWeb3Calldata(
  functionName: string,
  functionArgs?: string,
  ethValue?: string
): { data: string; value?: bigint } {
  const abiJson = JSON.stringify(WETH_ABI);
  const parsedAbi = JSON.parse(abiJson);

  const functionAbi = parsedAbi.find(
    (item: { type: string; name: string }) =>
      item.type === "function" && item.name === functionName
  );
  if (!functionAbi) {
    throw new Error(`Function ${functionName} not found in ABI`);
  }

  let args: unknown[] = [];
  if (functionArgs && functionArgs.trim() !== "") {
    const parsedArgs = JSON.parse(functionArgs);
    args = parsedArgs.filter((arg: unknown, index: number) => {
      if (arg !== "") {
        return true;
      }
      return parsedArgs.slice(index + 1).some((a: unknown) => a !== "");
    });
    args = reshapeArgsForAbi(args, functionAbi);
    const validation = validateArgsForAbi(args, functionAbi);
    if (!validation.ok) {
      throw new Error(`Validation failed: ${validation.error}`);
    }
  }

  const iface = new ethers.Interface(parsedAbi);
  const data = iface.encodeFunctionData(functionName, args);

  const value = ethValue ? ethers.parseEther(ethValue) : undefined;
  return { data, value };
}

describe.skipIf(!RPC_URL)("Web3 write-contract on-chain integration", () => {
  const getProvider = (): ethers.JsonRpcProvider =>
    new ethers.JsonRpcProvider(RPC_URL);

  it("deposit (payable, no args): estimateGas with ETH value", async () => {
    const { data, value } = buildWeb3Calldata("deposit", undefined, "0.001");

    const provider = getProvider();
    const gas = await provider.estimateGas({
      to: WETH_SEPOLIA,
      data,
      value,
      from: TEST_ADDRESS,
    });

    expect(gas).toBeGreaterThan(BigInt(0));
  }, 15_000);

  it("withdraw (uint256 arg): calldata encodes correctly", async () => {
    const { data } = buildWeb3Calldata("withdraw", '["1000000000000000000"]');

    const provider = getProvider();
    try {
      await provider.estimateGas({
        to: WETH_SEPOLIA,
        data,
        from: TEST_ADDRESS,
      });
    } catch (error) {
      const msg = String(error);
      expect(msg).not.toContain("INVALID_ARGUMENT");
      expect(msg).not.toContain("could not decode");
    }
  }, 15_000);

  it("approve (address + uint256 args): calldata encodes correctly", async () => {
    const { data } = buildWeb3Calldata(
      "approve",
      `["${TEST_ADDRESS}", "1000000000000000000"]`
    );

    const provider = getProvider();
    const gas = await provider.estimateGas({
      to: WETH_SEPOLIA,
      data,
      from: TEST_ADDRESS,
    });

    expect(gas).toBeGreaterThan(BigInt(0));
  }, 15_000);

  it("transfer (address + uint256 args): calldata encodes correctly", async () => {
    const { data } = buildWeb3Calldata("transfer", `["${TEST_ADDRESS}", "0"]`);

    const provider = getProvider();
    const gas = await provider.estimateGas({
      to: WETH_SEPOLIA,
      data,
      from: TEST_ADDRESS,
    });

    expect(gas).toBeGreaterThan(BigInt(0));
  }, 15_000);

  it("balanceOf (read via eth_call): returns decodable uint256", async () => {
    const { data } = buildWeb3Calldata("balanceOf", `["${TEST_ADDRESS}"]`);

    const provider = getProvider();
    const result = await provider.call({
      to: WETH_SEPOLIA,
      data,
    });

    const iface = new ethers.Interface(WETH_ABI);
    const decoded = iface.decodeFunctionResult("balanceOf", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("allowance (two address args via eth_call): returns decodable uint256", async () => {
    const { data } = buildWeb3Calldata(
      "allowance",
      `["${TEST_ADDRESS}", "${TEST_ADDRESS}"]`
    );

    const provider = getProvider();
    const result = await provider.call({
      to: WETH_SEPOLIA,
      data,
    });

    const iface = new ethers.Interface(WETH_ABI);
    const decoded = iface.decodeFunctionResult("allowance", result);
    expect(decoded).toBeDefined();
    expect(typeof decoded[0]).toBe("bigint");
  }, 15_000);

  it("rejects invalid ethValue at parseEther", () => {
    expect(() => buildWeb3Calldata("deposit", undefined, "abc")).toThrow();
  });

  it("rejects invalid JSON functionArgs", () => {
    expect(() => buildWeb3Calldata("withdraw", "{bad json")).toThrow();
  });
});
