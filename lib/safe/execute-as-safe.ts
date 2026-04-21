import "server-only";

import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc-provider";
import { buildExecTransactionCalldata } from "@/lib/safe/allowance-module";
import type { TransactionReceipt } from "@/lib/web3/chain-adapter/types";
import { getGasStrategy, type TriggerType } from "@/lib/web3/gas-strategy";
import { getNonceManager, type NonceSession } from "@/lib/web3/nonce-manager";

/**
 * Execute an arbitrary contract call from a deployed Safe's perspective.
 *
 * Given the inner target (contractAddress + ABI + functionKey + args + value),
 * builds `safe.execTransaction(innerTarget, value, innerCalldata, ...)` and
 * submits it with the Turnkey EOA as the signer. On-chain `msg.sender` at
 * the target becomes the Safe's address; funds for the inner call are drawn
 * from the Safe's balance, not the EOA's.
 *
 * Gas is still paid by the outer signer (Turnkey EOA) and the nonce advances
 * on the EOA. The Safe itself has no nonce from the EOA's perspective.
 */
export type ExecuteAsSafeRequest = {
  safeAddress: string;
  ownerAddress: string;
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  value?: bigint;
};

export type ExecuteAsSafeOptions = {
  chainId: number;
  triggerType: TriggerType;
  workflowId?: string;
  rpcManager?: RpcProviderManager;
};

export async function executeContractCallAsSafe(
  signer: ethers.Signer,
  request: ExecuteAsSafeRequest,
  session: NonceSession,
  options: ExecuteAsSafeOptions
): Promise<TransactionReceipt> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error("Signer has no provider");
  }

  const contractInterface = new ethers.Interface(request.abi);
  const innerCalldata = contractInterface.encodeFunctionData(
    request.functionKey,
    request.args
  );

  const outerCalldata = buildExecTransactionCalldata({
    to: request.contractAddress,
    data: innerCalldata,
    value: request.value ?? BigInt(0),
    ownerAddress: request.ownerAddress,
  });

  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const estimatedGas = options.rpcManager
    ? await options.rpcManager.executeWithFailover(
        (rpcProvider) =>
          rpcProvider.estimateGas({
            to: request.safeAddress,
            data: outerCalldata,
            from: request.ownerAddress,
          }),
        "preflight"
      )
    : await provider.estimateGas({
        to: request.safeAddress,
        data: outerCalldata,
        from: request.ownerAddress,
      });

  const gasConfig = await gasStrategy.getGasConfig(
    provider,
    options.triggerType,
    estimatedGas,
    options.chainId
  );

  const nonce = nonceManager.getNextNonce(session);

  const tx = await signer.sendTransaction({
    to: request.safeAddress,
    data: outerCalldata,
    value: BigInt(0),
    nonce,
    gasLimit: gasConfig.gasLimit,
    maxFeePerGas: gasConfig.maxFeePerGas,
    maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
    chainId: options.chainId,
  });

  await nonceManager.recordTransaction(
    session,
    nonce,
    tx.hash,
    options.workflowId,
    gasConfig.maxFeePerGas.toString()
  );

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Safe-routed transaction sent but receipt unavailable");
  }

  await nonceManager.confirmTransaction(tx.hash);
  return {
    hash: receipt.hash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.gasPrice,
    blockNumber: receipt.blockNumber,
  };
}

/**
 * Execute a native value transfer from the Safe. Wraps a zero-data call
 * through `safe.execTransaction` -- the Safe sends `amount` to `to` from
 * its own balance, and the Turnkey EOA signs the outer tx.
 */
export type ExecuteNativeAsSafeRequest = {
  safeAddress: string;
  ownerAddress: string;
  to: string;
  amount: bigint;
};

export async function executeNativeTransferAsSafe(
  signer: ethers.Signer,
  request: ExecuteNativeAsSafeRequest,
  session: NonceSession,
  options: ExecuteAsSafeOptions
): Promise<TransactionReceipt> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error("Signer has no provider");
  }

  const outerCalldata = buildExecTransactionCalldata({
    to: request.to,
    data: "0x",
    value: request.amount,
    ownerAddress: request.ownerAddress,
  });

  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const estimatedGas = options.rpcManager
    ? await options.rpcManager.executeWithFailover(
        (rpcProvider) =>
          rpcProvider.estimateGas({
            to: request.safeAddress,
            data: outerCalldata,
            from: request.ownerAddress,
          }),
        "preflight"
      )
    : await provider.estimateGas({
        to: request.safeAddress,
        data: outerCalldata,
        from: request.ownerAddress,
      });

  const gasConfig = await gasStrategy.getGasConfig(
    provider,
    options.triggerType,
    estimatedGas,
    options.chainId
  );

  const nonce = nonceManager.getNextNonce(session);

  const tx = await signer.sendTransaction({
    to: request.safeAddress,
    data: outerCalldata,
    value: BigInt(0),
    nonce,
    gasLimit: gasConfig.gasLimit,
    maxFeePerGas: gasConfig.maxFeePerGas,
    maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
    chainId: options.chainId,
  });

  await nonceManager.recordTransaction(
    session,
    nonce,
    tx.hash,
    options.workflowId,
    gasConfig.maxFeePerGas.toString()
  );

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Safe-routed native transfer sent but receipt unavailable");
  }

  await nonceManager.confirmTransaction(tx.hash);
  return {
    hash: receipt.hash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.gasPrice,
    blockNumber: receipt.blockNumber,
  };
}
