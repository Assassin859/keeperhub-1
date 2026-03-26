/**
 * Transaction Manager for KeeperHub Web3 Operations
 *
 * High-level wrapper that coordinates nonce management and gas strategy
 * with transaction execution. Provides a simple interface for workflow
 * steps to execute transactions with proper nonce handling and adaptive
 * gas estimation.
 *
 * submitAndConfirm / submitContractCallAndConfirm consolidate the
 * send -> record -> wait -> confirm -> explorer-link flow into one place
 * and add RPC failover: if the primary provider fails with a retryable
 * error, the signer (or contract) is reconnected to the fallback provider
 * and the send is retried once. Same nonce ensures idempotency.
 *
 * @see docs/keeperhub/KEEP-1240/nonce.md for nonce specification
 * @see docs/keeperhub/KEEP-1240/gas.md for gas strategy specification
 */

import { eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { initializeWalletSigner } from "@/lib/para/wallet-helpers";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc-provider";
import { isNonRetryableError } from "@/lib/rpc-provider/error-classification";
import {
  type TriggerType as GasTriggerType,
  getGasStrategy,
} from "./gas-strategy";
import { getNonceManager, type NonceSession } from "./nonce-manager";

export type TriggerType = GasTriggerType;

export type TransactionContext = {
  organizationId: string;
  executionId: string;
  workflowId?: string;
  chainId: number;
  rpcUrl: string;
  triggerType?: TriggerType;
  rpcManager?: RpcProviderManager;
};

export type TransactionResult = {
  success: boolean;
  txHash?: string;
  receipt?: ethers.TransactionReceipt;
  error?: string;
  nonce?: number;
};

export type SubmitAndConfirmOptions = {
  rpcManager: RpcProviderManager;
  session: NonceSession;
  nonce: number;
  workflowId?: string;
  chainId: number;
  maxFeePerGas: bigint;
};

export type SubmitAndConfirmResult = {
  txHash: string;
  receipt: ethers.TransactionReceipt;
  gasCostWei: string;
  transactionLink: string;
};

/**
 * Attempt to send a signer-based transaction with RPC failover.
 *
 * 1. Try sendTransaction on the current provider.
 * 2. If the error is non-retryable, throw immediately.
 * 3. If retryable and a fallback provider exists, reconnect the signer
 *    and retry once. Same nonce ensures idempotency.
 * 4. After successful send: record -> wait -> confirm -> explorer link.
 */
export async function submitAndConfirm(
  signer: ReturnType<typeof initializeWalletSigner> extends Promise<infer T>
    ? T
    : never,
  txRequest: ethers.TransactionRequest,
  options: SubmitAndConfirmOptions
): Promise<SubmitAndConfirmResult> {
  const { rpcManager, session, nonce, workflowId, chainId, maxFeePerGas } =
    options;
  const nonceManager = getNonceManager();

  let tx: ethers.TransactionResponse;
  try {
    tx = await signer.sendTransaction(txRequest);
  } catch (primaryError) {
    if (isNonRetryableError(primaryError)) {
      throw primaryError;
    }

    const fallbackProvider = rpcManager.getFallbackProvider();
    if (!fallbackProvider) {
      throw primaryError;
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        event: "WRITE_TX_FAILOVER",
        message: `Primary RPC failed during sendTransaction for chain ${rpcManager.getChainName()}, retrying on fallback`,
        chain: rpcManager.getChainName(),
        error:
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError),
        timestamp: new Date().toISOString(),
      })
    );

    const reconnectedSigner = signer.connect(fallbackProvider) as typeof signer;
    tx = await reconnectedSigner.sendTransaction(txRequest);
  }

  return await confirmAndBuildResult(
    tx,
    nonceManager,
    session,
    nonce,
    workflowId,
    chainId,
    maxFeePerGas
  );
}

/**
 * Attempt to send a contract method call with RPC failover.
 *
 * Same failover logic as submitAndConfirm but for contract interactions.
 * On failover, both the signer and contract are reconnected to the fallback.
 */
export async function submitContractCallAndConfirm(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  overrides: Record<string, unknown>,
  signer: ReturnType<typeof initializeWalletSigner> extends Promise<infer T>
    ? T
    : never,
  options: SubmitAndConfirmOptions
): Promise<SubmitAndConfirmResult> {
  const { rpcManager, session, nonce, workflowId, chainId, maxFeePerGas } =
    options;
  const nonceManager = getNonceManager();

  let tx: ethers.TransactionResponse;
  try {
    tx = await contract[method](...args, overrides);
  } catch (primaryError) {
    if (isNonRetryableError(primaryError)) {
      throw primaryError;
    }

    const fallbackProvider = rpcManager.getFallbackProvider();
    if (!fallbackProvider) {
      throw primaryError;
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        event: "WRITE_TX_CONTRACT_FAILOVER",
        message: `Primary RPC failed during ${method}() for chain ${rpcManager.getChainName()}, retrying on fallback`,
        chain: rpcManager.getChainName(),
        method,
        error:
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError),
        timestamp: new Date().toISOString(),
      })
    );

    const reconnectedSigner = signer.connect(fallbackProvider) as typeof signer;
    const reconnectedContract = contract.connect(
      reconnectedSigner
    ) as typeof contract;
    tx = await reconnectedContract[method](...args, overrides);
  }

  return await confirmAndBuildResult(
    tx,
    nonceManager,
    session,
    nonce,
    workflowId,
    chainId,
    maxFeePerGas
  );
}

/**
 * Shared post-send flow: record pending tx, wait for mining, confirm,
 * compute gas cost, and build explorer link.
 */
async function confirmAndBuildResult(
  tx: ethers.TransactionResponse,
  nonceManager: ReturnType<typeof getNonceManager>,
  session: NonceSession,
  nonce: number,
  workflowId: string | undefined,
  chainId: number,
  maxFeePerGas: bigint
): Promise<SubmitAndConfirmResult> {
  await nonceManager.recordTransaction(
    session,
    nonce,
    tx.hash,
    workflowId,
    maxFeePerGas.toString()
  );

  const receipt = await tx.wait();

  if (!receipt) {
    throw new Error("Transaction sent but receipt not available");
  }

  await nonceManager.confirmTransaction(tx.hash);

  const gasCostWei = (receipt.gasUsed * receipt.gasPrice).toString();

  const explorerConfig = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });
  const transactionLink = explorerConfig
    ? getTransactionUrl(explorerConfig, receipt.hash)
    : "";

  return {
    txHash: receipt.hash,
    receipt,
    gasCostWei,
    transactionLink,
  };
}

// ---------------------------------------------------------------------------
// Legacy helpers (still used by executeTransaction / executeContractTransaction)
// ---------------------------------------------------------------------------

/**
 * Execute a single transaction with nonce management and gas strategy.
 */
export async function executeTransaction(
  context: TransactionContext,
  walletAddress: string,
  buildTx: (nonce: number) => ethers.TransactionRequest,
  session: NonceSession
): Promise<TransactionResult> {
  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const nonce = nonceManager.getNextNonce(session);

  try {
    const baseTx = buildTx(nonce);

    const signer = await initializeWalletSigner(
      context.organizationId,
      context.rpcUrl
    );
    const provider = signer.provider;

    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const estimatedGas = await provider.estimateGas({
      ...baseTx,
      from: walletAddress,
    });

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      context.triggerType ?? "manual",
      estimatedGas,
      context.chainId
    );

    const txRequest: ethers.TransactionRequest = {
      ...baseTx,
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
    };

    const tx = await signer.sendTransaction(txRequest);

    await nonceManager.recordTransaction(
      session,
      nonce,
      tx.hash,
      context.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = await tx.wait();

    await nonceManager.confirmTransaction(tx.hash);

    return {
      success: true,
      txHash: tx.hash,
      receipt: receipt ?? undefined,
      nonce,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[TransactionManager] Transaction failed:",
      error,
      {
        chain_id: context.chainId.toString(),
        nonce: nonce.toString(),
      }
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      nonce,
    };
  }
}

/**
 * Execute a transaction via contract method call with nonce management and gas strategy.
 */
export async function executeContractTransaction(
  context: TransactionContext,
  _walletAddress: string,
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  session: NonceSession
): Promise<TransactionResult> {
  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const nonce = nonceManager.getNextNonce(session);

  try {
    const provider = contract.runner?.provider;
    if (!provider) {
      throw new Error("Contract has no provider");
    }

    const estimatedGas = await contract[method].estimateGas(...args);

    const gasConfig = await gasStrategy.getGasConfig(
      provider as ethers.Provider,
      context.triggerType ?? "manual",
      estimatedGas,
      context.chainId
    );

    const tx = await contract[method](...args, {
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
    });

    await nonceManager.recordTransaction(
      session,
      nonce,
      tx.hash,
      context.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = await tx.wait();

    await nonceManager.confirmTransaction(tx.hash);

    return {
      success: true,
      txHash: tx.hash,
      receipt: receipt ?? undefined,
      nonce,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[TransactionManager] Contract transaction failed:",
      error,
      {
        chain_id: context.chainId.toString(),
        nonce: nonce.toString(),
        method,
      }
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      nonce,
    };
  }
}

/**
 * Wrapper for workflow execution with nonce session management.
 * Handles session lifecycle (start, execute, end) automatically.
 */
export async function withNonceSession<T>(
  context: TransactionContext,
  walletAddress: string,
  fn: (session: NonceSession) => Promise<T>
): Promise<T> {
  const nonceManager = getNonceManager();
  const rpcManager =
    context.rpcManager ?? getRpcProviderFromUrls(context.rpcUrl);
  const provider = rpcManager.getProvider();

  const { session, validation } = await nonceManager.startSession(
    walletAddress,
    context.chainId,
    context.executionId,
    provider
  );

  if (!validation.valid) {
    console.warn(
      "[TransactionManager] Starting workflow with warnings:",
      validation.warnings
    );
  }

  try {
    return await fn(session);
  } finally {
    await nonceManager.endSession(session);
  }
}

/**
 * Get the current nonce from the chain for a wallet.
 * Useful for checking state without acquiring a lock.
 */
export async function getCurrentNonce(
  walletAddress: string,
  rpcUrl: string
): Promise<number> {
  const rpcManager = getRpcProviderFromUrls(rpcUrl);
  return await rpcManager.executeWithFailover((provider) =>
    provider.getTransactionCount(walletAddress, "pending")
  );
}
