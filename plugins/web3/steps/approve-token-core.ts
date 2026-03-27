/**
 * Core approve-token logic shared between web3 approve-token step and direct execution API.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple callers can reuse approval logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
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
import { parseTokenAddress } from "./transfer-token-core";

export type ApproveTokenCoreInput = {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  spenderAddress: string;
  amount: string;
  gasLimitMultiplier?: string;
  tokenAddress?: string;
  _context?: {
    executionId?: string;
    triggerType?: string;
    organizationId?: string;
  };
};

export type ApproveTokenResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
      approvedAmount: string;
      spender: string;
      symbol: string;
    }
  | { success: false; error: string };

/**
 * Core approve token logic
 *
 * Calls ERC20 approve(spender, amount) on the selected token contract.
 * Supports human-readable amounts (converted via decimals) and "max" for unlimited approval.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Token approval handler with comprehensive validation and error handling
export async function approveTokenCore(
  input: ApproveTokenCoreInput
): Promise<ApproveTokenResult> {
  const { network, spenderAddress, amount, gasLimitMultiplier, _context } =
    input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);

  // Get chain ID first (needed for token config parsing)
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Approve Token] Failed to resolve network",
      error,
      { plugin_name: "web3", action_name: "approve-token" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Parse token address from config
  const tokenAddress = await parseTokenAddress(input, chainId);

  // Validate token address
  if (!(tokenAddress && ethers.isAddress(tokenAddress))) {
    return {
      success: false,
      error: tokenAddress
        ? `Invalid token address: ${tokenAddress}`
        : "No token selected",
    };
  }

  // Validate spender address
  if (!ethers.isAddress(spenderAddress)) {
    return {
      success: false,
      error: `Invalid spender address: ${spenderAddress}`,
    };
  }

  // Validate amount
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
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
    "[Approve Token]",
    "approve-token"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const { organizationId, userId } = orgCtx;

  // Resolve RPC config (with failover)
  let rpcUrl: string;
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Approve Token] Failed to resolve RPC config",
      error,
      {
        plugin_name: "web3",
        action_name: "approve-token",
        chain_id: String(chainId),
      }
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
    // Initialize Para signer
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Create contract instance for pre-flight checks (decimals, symbol)
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    try {
      // Get token decimals and symbol
      const [decimals, symbol] = await Promise.all([
        contract.decimals() as Promise<bigint>,
        contract.symbol() as Promise<string>,
      ]);

      const decimalsNum = Number(decimals);

      // Convert amount to raw units (handle "max" for unlimited approval)
      let amountRaw: bigint;
      let approvedAmountDisplay: string;
      if (amount.trim().toLowerCase() === "max") {
        amountRaw = ethers.MaxUint256;
        approvedAmountDisplay = "unlimited";
      } else {
        try {
          amountRaw = ethers.parseUnits(amount, decimalsNum);
          approvedAmountDisplay = amount;
        } catch (error) {
          return {
            success: false,
            error: `Invalid amount format: ${getErrorMessage(error)}`,
          };
        }
      }

      const receipt = await adapter.executeContractCall(signer, {
        contractAddress: tokenAddress,
        abi: ERC20_ABI,
        functionKey: "approve",
        args: [spenderAddress, amountRaw],
      }, session, {
        triggerType: txContext.triggerType ?? "manual",
        gasOverrides: { multiplierOverride, gasLimitOverride },
        workflowId,
      });

      const gasUsedUnits = receipt.gasUsed.toString();
      const effectiveGasPrice = receipt.effectiveGasPrice.toString();
      const gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);

      return {
        success: true,
        transactionHash: receipt.hash,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
        approvedAmount: approvedAmountDisplay,
        spender: spenderAddress,
        symbol,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Approve Token] Transaction failed",
        error,
        {
          plugin_name: "web3",
          action_name: "approve-token",
          chain_id: String(chainId),
        }
      );
      return {
        success: false,
        error: formatContractError(
          error,
          contract.interface,
          "Token approval failed"
        ),
      };
    }
  });
}
