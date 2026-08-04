import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logSystemWarn, logUserError } from "@/lib/logging";
import {
  isSponsoredTxPendingError,
  isSponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";

export type SponsoredSendDecision =
  | {
      fallback: false;
      error: string;
      // Set only for the revert case: Turnkey confirms the tx mined, so the
      // hash is real and safe to surface. Absent for the pending case, since
      // there is no confirmed hash yet, only a Turnkey status id.
      transactionHash?: string;
      // Set only for the pending/unconfirmed case, so a failOnError=false
      // caller can never soften it into success: the transaction may still
      // land, and treating an unresolved in-flight send as a known, ignorable
      // failure would hide that from the operator. The revert case is a
      // clean, terminal outcome and stays eligible for softening.
      errorClass?: ExecutionErrorType;
    }
  | { fallback: true };

/**
 * Classify a throw from the Turnkey-sponsored send path and decide whether the
 * caller may retry the transaction via direct signing.
 *
 * Returns `fallback: false` (a terminal error result) whenever the sponsored
 * transaction is already committed on Turnkey's side -- it either reverted
 * on-chain, or was accepted but not yet confirmed. Re-sending in those cases
 * would broadcast a second transaction from the same wallet and race the
 * sponsored one. Returns `fallback: true` only for genuine pre-broadcast
 * failures, where direct signing is safe.
 *
 * Shared by every web3 write step so the "never double-send" rule stays
 * identical across write-contract, transfer-token, approve-token, and
 * transfer-funds.
 */
export function resolveSponsoredSendError(
  error: unknown,
  ctx: { logPrefix: string; actionName: string; chainId: number }
): SponsoredSendDecision {
  const { logPrefix, actionName, chainId } = ctx;

  if (isSponsoredTxRevertError(error)) {
    logUserError(
      ErrorCategory.TRANSACTION,
      `${logPrefix} Sponsored transaction reverted on-chain`,
      error,
      {
        plugin_name: "web3",
        action_name: actionName,
        chain_id: String(chainId),
        tx_hash: error.txHash,
        send_transaction_status_id: error.sendTransactionStatusId,
        revert_chain_depth: String(error.revertChain.length),
      }
    );
    return {
      fallback: false,
      error: `Transaction reverted: ${error.message} (tx ${error.txHash})`,
      transactionHash: error.txHash,
    };
  }

  if (isSponsoredTxPendingError(error)) {
    logSystemWarn(
      ErrorCategory.TRANSACTION,
      `${logPrefix} Sponsored transaction unconfirmed; not falling back to direct signing`,
      error,
      {
        plugin_name: "web3",
        action_name: actionName,
        chain_id: String(chainId),
        send_transaction_status_id: error.sendTransactionStatusId,
      }
    );
    return {
      fallback: false,
      error:
        "Sponsored transaction was submitted but not confirmed in time. It may still complete; not retrying to avoid a duplicate transaction.",
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }

  logUserError(
    ErrorCategory.TRANSACTION,
    `${logPrefix} Sponsorship attempted but failed, falling back to direct signing`,
    error,
    {
      plugin_name: "web3",
      action_name: actionName,
      chain_id: String(chainId),
    }
  );
  return { fallback: true };
}
