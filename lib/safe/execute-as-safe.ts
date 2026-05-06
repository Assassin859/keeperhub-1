import "server-only";

import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { buildExecTransactionCalldata } from "@/lib/safe/allowance-module";
import { buildExecTransactionWithRoleCalldata } from "@/lib/safe/zodiac-roles";
import type { TransactionReceipt } from "@/lib/web3/chain-adapter/types";
import { getGasStrategy } from "@/lib/web3/gas-strategy";
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
  /**
   * Retained for back-compat with safe-routing call sites that still pass it;
   * no longer consumed by gasStrategy.getGasConfig (post-staging refactor).
   */
  triggerType?: string;
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

// ---------------------------------------------------------------------------
// Role-routed variants -- used when a Zodiac Roles Modifier is installed on
// the Safe and the signer-resolver returns kind === "safe-role".
//
// The delegate (same Turnkey EOA in MVP) sends directly to the modifier
// (NOT through the Safe). The modifier validates target + function + params
// against the role, then calls back into the Safe via
// `execTransactionFromModule`. msg.sender at the target still resolves to
// the Safe address.
// ---------------------------------------------------------------------------

export type ExecuteAsRoleRequest = {
  safeAddress: string;
  /** Delegate EOA authorised to use the role (our Turnkey EOA) */
  delegateAddress: string;
  /** Proxied Roles Modifier address deployed per-Safe */
  rolesModifierAddress: string;
  /** bytes32 role key */
  roleKey: string;
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  value?: bigint;
};

export async function executeContractCallAsRole(
  signer: ethers.Signer,
  request: ExecuteAsRoleRequest,
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

  const outerCalldata = buildExecTransactionWithRoleCalldata({
    to: request.contractAddress,
    value: request.value ?? BigInt(0),
    data: innerCalldata,
    operation: 0,
    roleKey: request.roleKey,
    shouldRevert: true,
  });

  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const estimatedGas = options.rpcManager
    ? await options.rpcManager.executeWithFailover(
        (rpcProvider) =>
          rpcProvider.estimateGas({
            to: request.rolesModifierAddress,
            data: outerCalldata,
            from: request.delegateAddress,
          }),
        "preflight"
      )
    : await provider.estimateGas({
        to: request.rolesModifierAddress,
        data: outerCalldata,
        from: request.delegateAddress,
      });

  const gasConfig = await gasStrategy.getGasConfig(
    provider,
    estimatedGas,
    options.chainId
  );

  const nonce = nonceManager.getNextNonce(session);

  const tx = await signer.sendTransaction({
    to: request.rolesModifierAddress,
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
    throw new Error("Role-routed transaction sent but receipt unavailable");
  }
  await nonceManager.confirmTransaction(tx.hash);
  return {
    hash: receipt.hash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.gasPrice,
    blockNumber: receipt.blockNumber,
  };
}

export type ExecuteNativeAsRoleRequest = {
  safeAddress: string;
  delegateAddress: string;
  rolesModifierAddress: string;
  roleKey: string;
  to: string;
  amount: bigint;
};

export async function executeNativeTransferAsRole(
  signer: ethers.Signer,
  request: ExecuteNativeAsRoleRequest,
  session: NonceSession,
  options: ExecuteAsSafeOptions
): Promise<TransactionReceipt> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error("Signer has no provider");
  }

  const outerCalldata = buildExecTransactionWithRoleCalldata({
    to: request.to,
    value: request.amount,
    data: "0x",
    operation: 0,
    roleKey: request.roleKey,
    shouldRevert: true,
  });

  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const estimatedGas = options.rpcManager
    ? await options.rpcManager.executeWithFailover(
        (rpcProvider) =>
          rpcProvider.estimateGas({
            to: request.rolesModifierAddress,
            data: outerCalldata,
            from: request.delegateAddress,
          }),
        "preflight"
      )
    : await provider.estimateGas({
        to: request.rolesModifierAddress,
        data: outerCalldata,
        from: request.delegateAddress,
      });

  const gasConfig = await gasStrategy.getGasConfig(
    provider,
    estimatedGas,
    options.chainId
  );

  const nonce = nonceManager.getNextNonce(session);

  const tx = await signer.sendTransaction({
    to: request.rolesModifierAddress,
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
    throw new Error("Role-routed native transfer sent but receipt unavailable");
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
