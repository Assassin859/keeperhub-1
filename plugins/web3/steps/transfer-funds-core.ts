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
import { chains, explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { generateId } from "@/lib/utils/id";
import {
  executeNativeTransferAsRole,
  executeNativeTransferAsSafe,
} from "@/lib/safe/execute-as-safe";
import { resolveSignerMode } from "@/lib/safe/signer-resolver";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import {
  classifyRevert,
  formatContractError,
  type RevertKind,
} from "@/lib/web3/decode-revert-error";
import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { executeSponsoredTransaction } from "@/lib/web3/sponsored-transaction-manager";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

export type TransferFundsCoreInput = {
  network: string;
  amount: string;
  recipientAddress: string;
  gasLimitMultiplier?: string;
  // KEEP-137: Route through private mempool (Flashbots Protect). Skips
  // ERC-4337 sponsorship -- mutually exclusive.
  usePrivateMempool?: boolean;
  // Strict mode: when true and usePrivateMempool is true, failing to reach the
  // private RPC does NOT fall back to the public mempool. Ignored otherwise.
  strict?: boolean;
  _context?: {
    executionId?: string;
    organizationId?: string;
  };
};

export type TransferFundsResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
    }
  | { success: false; error: string; rejection?: RevertKind };

/**
 * Core transfer funds logic
 *
 * Shared between the web3 transfer-funds step and the direct execution API.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Transfer handler with sponsorship attempt + fallback + validation
export async function transferFundsCore(
  input: TransferFundsCoreInput
): Promise<TransferFundsResult> {
  const { network, amount, recipientAddress, gasLimitMultiplier, usePrivateMempool,
    strict,
    _context } =
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

    rpcManager = await getRpcProvider({
      chainId,
      userId,
      usePrivateMempool,
      strict,
    });
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

  // Decide whether to route this write through the org's Safe on this chain.
  const signerMode = await resolveSignerMode(organizationId, chainId);

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
    executionId: _context.executionId ?? `direct-${generateId()}`,
    workflowId,
    chainId,
    rpcUrl,
    rpcManager,
  };

  // KEEP-137: skip sponsorship when routing through a private mempool --
  // ERC-4337 bundlers use their own RPC (Pimlico), which bypasses Flashbots Protect.
  // KEEP-177: skip sponsorship in Safe mode -- the 4337 bundler sends from
  // its own smart account, which would change msg.sender away from the Safe.
  if (
    !usePrivateMempool &&
    signerMode.kind === "eoa" &&
    isGasSponsorshipEnabled()
  ) {
    // Try gas-sponsored execution first (ERC-4337 via Pimlico)
    try {
      const sponsoredResult = await executeSponsoredTransaction({
        organizationId,
        executionId: _context.executionId ?? "direct-execution",
        chainId,
        rpcUrl,
        walletAddress,
        to: recipientAddress,
        value: amountInWei,
      });

      if (sponsoredResult !== null) {
        const explorerConfig = await db.query.explorerConfigs.findFirst({
          where: eq(explorerConfigs.chainId, chainId),
        });
        const transactionLink = explorerConfig
          ? getTransactionUrl(explorerConfig, sponsoredResult.transactionHash)
          : "";

        return {
          success: true,
          transactionHash: sponsoredResult.transactionHash,
          transactionLink,
          gasUsed: sponsoredResult.gasUsed,
          gasUsedUnits: sponsoredResult.gasUsedUnits,
          effectiveGasPrice: sponsoredResult.effectiveGasPrice,
        };
      }

      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Funds] Sponsorship skipped (credits exhausted, chain unsupported, or client creation failed), falling back to direct signing",
        undefined,
        {
          plugin_name: "web3",
          action_name: "transfer-funds",
          chain_id: String(chainId),
        }
      );
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Funds] Sponsorship attempted but failed, falling back to direct signing",
        error,
        {
          plugin_name: "web3",
          action_name: "transfer-funds",
          chain_id: String(chainId),
        }
      );
    }
  }

  // Fall back to direct signing with nonce management and RPC failover
  const adapter = getChainAdapter(chainId);

  return withNonceSession(txContext, walletAddress, async (session) => {
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Preflight native balance check. Mirrors the ERC-20 preflight in
    // transfer-token-core: read the funding address' native balance and
    // short-circuit with a clean message before the orchestrator simulates
    // and surfaces a cryptic revert. Holder is the Safe in safe / safe-role
    // mode (funds come from the Safe's balance), otherwise the EOA. An
    // RPC failure here surfaces as a step error to stay consistent with
    // transfer-token-core's pattern. See review #923-r3 (MEDIUM).
    const fundingHolderAddress: string =
      signerMode.kind === "safe-role" || signerMode.kind === "safe"
        ? signerMode.safeAddress
        : walletAddress;
    const nativeBalance = await rpcManager.executeWithFailover(
      (p) => p.getBalance(fundingHolderAddress),
      "preflight"
    );
    if (nativeBalance < amountInWei) {
      const balanceFormatted = ethers.formatEther(nativeBalance);
      const requestedFormatted = ethers.formatEther(amountInWei);
      // Look up the chain's native symbol so the error reads "Insufficient
      // ETH balance" / "Insufficient BNB balance" instead of the chain-
      // agnostic "native". Looked up lazily because this branch only fires
      // on the slow / unhappy path.
      const chainRow = await db
        .select({ symbol: chains.symbol })
        .from(chains)
        .where(eq(chains.chainId, chainId))
        .limit(1);
      const nativeSymbol = chainRow[0]?.symbol ?? "native";
      return {
        success: false,
        error: `Insufficient ${nativeSymbol} balance. Have: ${balanceFormatted}, Need: ${requestedFormatted}`,
      };
    }

    try {
      let receipt: Awaited<ReturnType<typeof adapter.sendTransaction>>;
      if (signerMode.kind === "safe-role") {
        receipt = await executeNativeTransferAsRole(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            delegateAddress: signerMode.delegateAddress,
            rolesModifierAddress: signerMode.rolesModifierAddress,
            roleKey: signerMode.roleKey,
            to: recipientAddress,
            amount: amountInWei,
          },
          session,
          {
            chainId,
            workflowId,
            rpcManager,
          }
        );
      } else if (signerMode.kind === "safe") {
        receipt = await executeNativeTransferAsSafe(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            ownerAddress: signerMode.ownerAddress,
            to: recipientAddress,
            amount: amountInWei,
          },
          session,
          {
            chainId,
            workflowId,
            rpcManager,
          }
        );
      } else {
        receipt = await adapter.sendTransaction(
          signer,
          {
            to: recipientAddress,
            value: amountInWei,
          },
          session,
          {
            gasOverrides: { multiplierOverride, gasLimitOverride },
            workflowId,
            rpcManager,
          }
        );
      }

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
      const rejection = classifyRevert(error);
      return {
        success: false,
        error: formatContractError(error, undefined, "Transaction failed"),
        ...(rejection.kind !== "unknown" ? { rejection } : {}),
      };
    }
  });
}
