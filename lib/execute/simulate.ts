import "server-only";

import { ethers } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import { decodeRevertReason } from "@/lib/web3/decode-revert-error";
import { getOrganizationWalletAddress } from "@/lib/web3/wallet-helpers";
import { parseTokenAddress } from "@/plugins/web3/steps/transfer-token-core";

/**
 * Read-only execution-path simulator.
 *
 * Mirrors the input shape and chain-routing of the broadcast cores
 * (writeContractCore / transferFundsCore / transferTokenCore) but never
 * signs or sends a transaction. The result reports the gas the network
 * would charge, the decoded return value (if any), and whether the
 * call would revert with the decoded reason.
 *
 * Every chain call is routed through rpcManager.executeWithFailover so
 * a primary-RPC blip falls over to the chain's configured fallback,
 * matching the behaviour of read paths in the broadcast cores.
 *
 * Known limitation: `from` is resolved via getOrganizationWalletAddress
 * (the org's EOA / smart account address). Orgs that route writes
 * through a Safe will produce a simulation that reflects the EOA
 * sending the call, not the Safe. This still catches most config bugs
 * (bad ABI, bad args, insufficient balance, allowance mismatches) but
 * does not perfectly mirror Safe-routed msg.sender semantics.
 */

const ERC20_TRANSFER_ABI_JSON = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
]);

const ERC20_DECIMALS_ABI = [
  "function decimals() view returns (uint8)",
] as const;

export type SimulateSuccess = {
  success: true;
  status: "simulated";
  from: string;
  to: string;
  value: string;
  gasEstimate: string;
  simulatedReturnValue: unknown;
  wouldRevert: false;
};

export type SimulateFailure = {
  success: false;
  status: "simulated";
  from: string;
  to: string;
  value: string;
  wouldRevert: true;
  revertReason: string;
  error: string;
};

export type SimulateResult = SimulateSuccess | SimulateFailure;

export type SimulateContractCallInput = {
  organizationId: string;
  network: string;
  contractAddress: string;
  abi: string;
  functionName: string;
  functionArgs?: string;
  /** Decimal ETH (or native unit) value sent with the call. */
  value?: string;
};

export type SimulateNativeTransferInput = {
  organizationId: string;
  network: string;
  recipientAddress: string;
  /** Decimal ETH (or native unit). */
  amount: string;
};

export type SimulateTokenTransferInput = {
  organizationId: string;
  network: string;
  /**
   * Either a bare token address, or a `tokenConfig` payload (string or
   * object) accepted by the broadcast path. When both are missing the
   * call fails with a 400-style result.
   */
  tokenAddress?: string;
  tokenConfig?: string | Record<string, unknown>;
  recipientAddress: string;
  /** Decimal token-unit amount. */
  amount: string;
  /**
   * Optional explicit decimals override. If omitted the simulator
   * looks up the token's `decimals()` on-chain (with RPC failover) so
   * USDC / USDT etc. do not get parsed at the default 18.
   */
  decimals?: number;
};

function serializeForJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeForJson);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeForJson(v);
    }
    return out;
  }
  return value;
}

function failure(
  from: string,
  to: string,
  value: bigint,
  message: string
): SimulateFailure {
  return {
    success: false,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    wouldRevert: true,
    revertReason: message,
    error: message,
  };
}

async function getRpcManagerForChain(
  network: string
): Promise<{ rpc: RpcProviderManager; chainId: number }> {
  const chainId = getChainIdFromNetwork(network);
  const rpc = await getRpcProvider({ chainId });
  return { rpc, chainId };
}

function parseFunctionArgs(raw: string | undefined): unknown[] | string {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return "functionArgs must be a JSON array";
    }
    return parsed;
  } catch {
    return "functionArgs is not valid JSON";
  }
}

function parseAbiArray(rawAbi: string): unknown[] | string {
  try {
    const parsed = JSON.parse(rawAbi) as unknown;
    if (!Array.isArray(parsed)) {
      return "ABI must be a JSON array";
    }
    return parsed;
  } catch {
    return "ABI is not valid JSON";
  }
}

function parseValue(raw: string | undefined): bigint | string {
  if (!raw) {
    return BigInt(0);
  }
  try {
    return ethers.parseEther(raw);
  } catch {
    return `Invalid value (expected decimal ether): ${raw}`;
  }
}

export async function simulateContractCall(
  input: SimulateContractCallInput
): Promise<SimulateResult> {
  const from = await getOrganizationWalletAddress(input.organizationId);
  const to = input.contractAddress;

  const valueOrError = parseValue(input.value);
  if (typeof valueOrError === "string") {
    return failure(from, to, BigInt(0), valueOrError);
  }
  const value = valueOrError;

  const abiArrayOrError = parseAbiArray(input.abi);
  if (typeof abiArrayOrError === "string") {
    return failure(from, to, value, abiArrayOrError);
  }
  const abiArray = abiArrayOrError;

  const abiFn = findAbiFunction(abiArray as AbiItem[], input.functionName);
  if (!abiFn) {
    return failure(
      from,
      to,
      value,
      `Function ${input.functionName} not found in ABI`
    );
  }

  const argsOrError = parseFunctionArgs(input.functionArgs);
  if (typeof argsOrError === "string") {
    return failure(from, to, value, argsOrError);
  }

  const iface = new ethers.Interface(abiArray as ethers.InterfaceAbi);
  let encodedData: string;
  try {
    const coerced = coerceArgsForAbi(argsOrError, abiFn);
    const reshaped = reshapeArgsForAbi(coerced, abiFn);
    encodedData = iface.encodeFunctionData(input.functionName, reshaped);
  } catch (err) {
    return failure(
      from,
      to,
      value,
      `Failed to encode call: ${getErrorMessage(err)}`
    );
  }

  const { rpc } = await getRpcManagerForChain(input.network);
  const tx: ethers.TransactionRequest = { from, to, data: encodedData, value };

  let gasEstimate: bigint;
  let returnData: string;
  try {
    // executeWithFailover routes the read through the chain's
    // fallback RPC when the primary blips, matching the read path
    // in the broadcast cores.
    [gasEstimate, returnData] = await rpc.executeWithFailover(
      (p) => Promise.all([p.estimateGas(tx), p.call(tx)]),
      "preflight"
    );
  } catch (err) {
    const reason =
      decodeRevertReason(err, iface) ??
      `Simulation reverted: ${getErrorMessage(err)}`;
    return failure(from, to, value, reason);
  }

  let simulatedReturnValue: unknown = null;
  if (returnData && returnData !== "0x") {
    try {
      const decoded = iface.decodeFunctionResult(
        input.functionName,
        returnData
      );
      simulatedReturnValue =
        decoded.length === 1 ? decoded[0] : Array.from(decoded);
    } catch {
      simulatedReturnValue = returnData;
    }
  }

  return {
    success: true,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    gasEstimate: gasEstimate.toString(),
    simulatedReturnValue: serializeForJson(simulatedReturnValue),
    wouldRevert: false,
  };
}

export async function simulateNativeTransfer(
  input: SimulateNativeTransferInput
): Promise<SimulateResult> {
  const from = await getOrganizationWalletAddress(input.organizationId);
  const to = input.recipientAddress;

  const valueOrError = parseValue(input.amount);
  if (typeof valueOrError === "string") {
    return failure(from, to, BigInt(0), valueOrError);
  }
  const value = valueOrError;

  const { rpc } = await getRpcManagerForChain(input.network);
  const tx: ethers.TransactionRequest = { from, to, value };

  // Run estimateGas + provider.call together so a contract recipient
  // (fallback handler, precompile, etc.) surfaces its return bytes
  // alongside the gas estimate. For an EOA recipient the call returns
  // "0x" and simulatedReturnValue ends up null.
  let gasEstimate: bigint;
  let returnData: string;
  try {
    [gasEstimate, returnData] = await rpc.executeWithFailover(
      (p) => Promise.all([p.estimateGas(tx), p.call(tx)]),
      "preflight"
    );
  } catch (err) {
    return failure(
      from,
      to,
      value,
      `Simulation reverted: ${getErrorMessage(err)}`
    );
  }

  return {
    success: true,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    gasEstimate: gasEstimate.toString(),
    simulatedReturnValue: returnData && returnData !== "0x" ? returnData : null,
    wouldRevert: false,
  };
}

async function fetchTokenDecimals(
  rpc: RpcProviderManager,
  tokenAddress: string
): Promise<number> {
  const decimals = await rpc.executeWithFailover((p) => {
    const contract = new ethers.Contract(tokenAddress, ERC20_DECIMALS_ABI, p);
    return contract.decimals() as Promise<bigint>;
  }, "preflight");
  return Number(decimals);
}

export async function simulateTokenTransfer(
  input: SimulateTokenTransferInput
): Promise<SimulateResult> {
  const { rpc, chainId } = await getRpcManagerForChain(input.network);

  const resolvedTokenAddress = await parseTokenAddress(
    {
      tokenConfig: input.tokenConfig ?? "",
      tokenAddress: input.tokenAddress,
    },
    chainId
  );
  if (!resolvedTokenAddress) {
    const from = await getOrganizationWalletAddress(input.organizationId);
    return failure(
      from,
      input.tokenAddress ?? "",
      BigInt(0),
      "Simulating a token transfer requires a resolvable `tokenAddress` or `tokenConfig`"
    );
  }

  const decimals =
    input.decimals ?? (await fetchTokenDecimals(rpc, resolvedTokenAddress));

  let amountUnits: bigint;
  try {
    amountUnits = ethers.parseUnits(input.amount, decimals);
  } catch {
    const from = await getOrganizationWalletAddress(input.organizationId);
    return failure(
      from,
      resolvedTokenAddress,
      BigInt(0),
      `Invalid amount for ${decimals} decimals: ${input.amount}`
    );
  }

  return simulateContractCall({
    organizationId: input.organizationId,
    network: input.network,
    contractAddress: resolvedTokenAddress,
    abi: ERC20_TRANSFER_ABI_JSON,
    functionName: "transfer",
    functionArgs: JSON.stringify([
      input.recipientAddress,
      amountUnits.toString(),
    ]),
    value: undefined,
  });
}
