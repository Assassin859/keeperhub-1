/**
 * Core transfer-funds logic shared between web3 transfer-funds step and direct execution API.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple callers can reuse transfer logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { formatContractError } from "@/lib/web3/decode-revert-error";
import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

export type TransferFundsCoreInput = {
  network: string;
  amount: string;
  recipientAddress: string;
  gasLimitMultiplier?: string;
  _context?: {
    executionId?: string;
    triggerType?: string;
    organizationId?: string;
  };
};

export type TransferFundsResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
    }
  | { success: false; error: string };

/**
 * Core transfer funds logic
 *
 * Shared between the web3 transfer-funds step and the direct execution API.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
export async function transferFundsCore(
  input: TransferFundsCoreInput
): Promise<TransferFundsResult> {
  const { network, amount, recipientAddress, gasLimitMultiplier, _context } =
    input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);

  // Validate recipient address
  if (!ethers.isAddress(recipientAddress)) {
    return {
      success: false,
      error: `Invalid recipient address: ${recipientAddress}`,
    };
  }

  // Validate amount
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  let amountInWei: bigint;
  try {
    amountInWei = ethers.parseEther(amount);
  } catch (error) {
    return {
      success: false,
      error: `Invalid amount format: ${getErrorMessage(error)}`,
    };
  }

  // Resolve organization context
  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Transfer Funds]",
    "transfer-funds"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const { organizationId, userId } = orgCtx;

  // Get chain ID and resolve RPC config (with failover)
  let chainId: number;
  let rpcUrl: string;
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    chainId = getChainIdFromNetwork(network);

    rpcManager = await getRpcProvider({ chainId, userId });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Transfer Funds] Failed to resolve RPC config",
      error,
      { plugin_name: "web3", action_name: "transfer-funds" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Get wallet address for nonce management
  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
    };
  }

  // Get workflow ID for transaction tracking (only for workflow executions)
  let workflowId: string | undefined;
  if (_context.executionId && !_context.organizationId) {
    try {
      const execution = await db
        .select({ workflowId: workflowExecutions.workflowId })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, _context.executionId))
        .then((rows) => rows[0]);
      workflowId = execution?.workflowId ?? undefined;
    } catch {
      // Non-critical - workflowId is optional for tracking
    }
  }

  // Build transaction context
  const txContext: TransactionContext = {
    organizationId,
    executionId: _context.executionId ?? "direct-execution",
    workflowId,
    chainId,
    rpcUrl,
    triggerType: _context.triggerType as TransactionContext["triggerType"],
    rpcManager,
  };

  const adapter = getChainAdapter(chainId);

  // Execute transaction with nonce management
  return withNonceSession(txContext, walletAddress, async (session) => {
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    try {
      const receipt = await adapter.sendTransaction(signer, {
        to: recipientAddress,
        value: amountInWei,
      }, session, {
        triggerType: txContext.triggerType ?? "manual",
        gasOverrides: { multiplierOverride, gasLimitOverride },
        workflowId,
      });

      const gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);

      return {
        success: true,
        transactionHash: receipt.hash,
        transactionLink,
        gasUsed: gasCostWei,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Funds] Transaction failed",
        error,
        {
          plugin_name: "web3",
          action_name: "transfer-funds",
          chain_id: String(chainId),
        }
      );
      return {
        success: false,
        error: formatContractError(error, undefined, "Transaction failed"),
      };
    }
  });
}
