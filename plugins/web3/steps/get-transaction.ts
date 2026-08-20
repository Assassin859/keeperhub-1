import "server-only";

import type { VersionedTransactionResponse } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getAddressUrl, getTransactionUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import { validateChainTxHash } from "@/lib/web3/validate-chain-address";

/**
 * Index 0 of a transaction's account keys is always the fee payer - the
 * same convention SolanaChainAdapter relies on when reading back simulated
 * fee-payer state (see solana.ts's buildSignAndSimulate).
 */
function getSolanaFeePayer(tx: VersionedTransactionResponse): string {
  const feePayer = tx.transaction.message
    .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
    .get(0);
  if (!feePayer) {
    throw new Error(
      "[Get Transaction] Transaction has no fee payer account key"
    );
  }
  return feePayer.toBase58();
}

async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.userId;
}

type GetTransactionResult =
  | {
      success: true;
      hash: string;
      from: string;
      to: string | null;
      value: string;
      input: string;
      nonce: number;
      gasLimit: string;
      blockNumber: number | null;
      transactionLink: string;
      fromLink: string;
      toLink: string;
    }
  | { success: false; error: string };

export type GetTransactionCoreInput = {
  network: string;
  transactionHash: string;
};

export type GetTransactionInput = StepInput & GetTransactionCoreInput;

async function stepHandler(
  input: GetTransactionInput
): Promise<GetTransactionResult> {
  const { network, transactionHash, _context } = input;

  if (!transactionHash?.trim()) {
    return {
      success: false,
      error: "Transaction hash is required",
    };
  }

  const hash = transactionHash.trim();

  // Resolve the chain first so hash-format validation can branch on the
  // chain family (EVM vs Solana) - see lib/web3/validate-chain-address.ts.
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  if (!validateChainTxHash(hash, chainId)) {
    return {
      success: false,
      error: `Invalid transaction hash format: ${hash}`,
    };
  }

  const isSolana = isSolanaChain(chainId);
  const userId = await getUserIdFromExecution(_context?.executionId);

  // Resolve RPC provider with failover support (EVM only). SolanaChainAdapter
  // owns its own provider manager, so the Solana path skips this entirely.
  let rpcManager: RpcProviderManager | undefined;
  if (!isSolana) {
    try {
      rpcManager = await getRpcProvider({ chainId, userId });
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  try {
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });

    if (isSolana) {
      const adapter = getChainAdapter(chainId) as SolanaChainAdapter;
      const tx = await adapter.executeWithSolanaFailover((connection) =>
        connection.getTransaction(hash, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      );

      if (!tx) {
        return {
          success: false,
          error: `Transaction not found: ${hash}`,
        };
      }

      const feePayer = getSolanaFeePayer(tx);
      const transactionLink = explorerConfig
        ? getTransactionUrl(explorerConfig, hash)
        : "";
      const fromLink = explorerConfig
        ? getAddressUrl(explorerConfig, feePayer)
        : "";

      return {
        success: true,
        hash,
        from: feePayer,
        // Solana has no single recipient: a transaction is a list of
        // instructions, each with its own accounts.
        to: null,
        // Solana has no single top-level transfer amount the way an EVM
        // transaction does.
        value: "0",
        input: "",
        nonce: 0,
        // Compute units are the closest Solana analogue to an EVM gas limit.
        gasLimit: String(tx.meta?.computeUnitsConsumed ?? 0),
        blockNumber: tx.slot,
        transactionLink,
        fromLink,
        toLink: "",
      };
    }

    const tx = await (rpcManager as RpcProviderManager).executeWithFailover(
      async (provider) => provider.getTransaction(hash)
    );

    if (!tx) {
      return {
        success: false,
        error: `Transaction not found: ${hash}`,
      };
    }

    const transactionLink = explorerConfig
      ? getTransactionUrl(explorerConfig, hash)
      : "";
    const fromLink = explorerConfig
      ? getAddressUrl(explorerConfig, tx.from)
      : "";
    const toLink =
      explorerConfig && tx.to ? getAddressUrl(explorerConfig, tx.to) : "";

    return {
      success: true,
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: ethers.formatEther(tx.value),
      input: tx.data,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit.toString(),
      blockNumber: tx.blockNumber,
      transactionLink,
      fromLink,
      toLink,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to fetch transaction: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Get Transaction Step
 * Fetches full transaction details by hash via eth_getTransactionByHash.
 * Returns from, to, value, input (calldata), nonce, gas, and explorer links.
 */
export async function getTransactionStep(
  input: GetTransactionInput
): Promise<GetTransactionResult> {
  "use step";

  let enrichedInput: GetTransactionInput & { transactionLink?: string } = input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const transactionLink = getTransactionUrl(
        explorerConfig,
        input.transactionHash
      );
      if (transactionLink) {
        enrichedInput = { ...input, transactionLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return await withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "get-transaction",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(enrichedInput, () => stepHandler(input))
  );
}

getTransactionStep.maxRetries = 0;

export const _integrationType = "web3";
