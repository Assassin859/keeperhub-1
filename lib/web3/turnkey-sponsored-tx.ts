import "server-only";
import type { Hex } from "viem";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import { toCaip2 } from "@/lib/web3/turnkey-sponsorship-config";

/**
 * Wrapper around Turnkey's Gas Station / Transaction Management API.
 *
 * Turnkey's native sponsorship is NOT an ERC-4337 paymaster. It is a single
 * activity (`ethSendTransaction` with `sponsor: true`) that signs the
 * transaction with the sub-org's wallet, fills gas from Turnkey's Gas
 * Station, and broadcasts. The activity returns a `sendTransactionStatusId`
 * which we poll until the transaction is broadcast and a hash is available.
 *
 * If the chain is not supported, or the polling deadline expires, callers
 * receive null and should fall back to direct signing.
 */

const STATUS_POLL_INTERVAL_MS = 1000;
const STATUS_POLL_TIMEOUT_MS = 30_000;

const TERMINAL_FAILURE_STATUSES = new Set([
  "TRANSACTION_STATUS_FAILED",
  "TRANSACTION_STATUS_REJECTED",
  "TRANSACTION_STATUS_TIMEOUT",
  "TRANSACTION_STATUS_REVERTED",
]);

const TERMINAL_SUCCESS_STATUSES = new Set([
  "TRANSACTION_STATUS_BROADCASTED",
  "TRANSACTION_STATUS_CONFIRMED",
  "TRANSACTION_STATUS_FINALIZED",
]);

export type TurnkeySponsoredTxParams = {
  subOrgId: string;
  walletAddress: string;
  chainId: number;
  to: string;
  value?: bigint;
  data?: Hex;
};

export type TurnkeySponsoredTxResult = {
  txHash: Hex;
  sendTransactionStatusId: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Submit a sponsored EVM transaction via Turnkey Gas Station and wait
 * for the broadcast tx hash. Returns null on any failure so callers can
 * fall back to direct signing.
 */
export async function submitTurnkeySponsoredTransaction(
  params: TurnkeySponsoredTxParams
): Promise<TurnkeySponsoredTxResult | null> {
  const caip2 = toCaip2(params.chainId);
  if (caip2 === null) {
    return null;
  }

  const turnkey = getTurnkeyClientForOrg(params.subOrgId);
  const client = turnkey.apiClient();

  let statusId: string;
  try {
    const submitResponse = await client.ethSendTransaction({
      organizationId: params.subOrgId,
      from: params.walletAddress,
      sponsor: true,
      // The SDK v5.2.0 CAIP-2 enum does not include Arbitrum (eip155:42161)
      // even though it appears in Turnkey's Gas Station docs. Cast through
      // a wider string type so we can probe Arbitrum at runtime; Turnkey
      // will reject the activity if it is genuinely unsupported.
      // biome-ignore lint/suspicious/noExplicitAny: SDK CAIP-2 enum lags Turnkey's actual chain coverage; runtime is authoritative
      caip2: caip2 as any,
      to: params.to,
      value: params.value === undefined ? undefined : params.value.toString(),
      data: params.data,
    });

    statusId = submitResponse.sendTransactionStatusId;
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Turnkey Sponsorship] ethSendTransaction failed",
      error,
      {
        service: "turnkey",
        chain_id: params.chainId.toString(),
      }
    );
    return null;
  }

  const txHash = await pollForTxHash(params.subOrgId, statusId);
  if (txHash === null) {
    return null;
  }

  return { txHash, sendTransactionStatusId: statusId };
}

async function pollForTxHash(
  subOrgId: string,
  sendTransactionStatusId: string
): Promise<Hex | null> {
  const turnkey = getTurnkeyClientForOrg(subOrgId);
  const client = turnkey.apiClient();
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await client.getSendTransactionStatus({
        organizationId: subOrgId,
        sendTransactionStatusId,
      });

      if (TERMINAL_FAILURE_STATUSES.has(response.txStatus)) {
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[Turnkey Sponsorship] Transaction terminated with failure status",
          new Error(response.txError ?? response.txStatus),
          {
            service: "turnkey",
            send_transaction_status_id: sendTransactionStatusId,
            tx_status: response.txStatus,
          }
        );
        return null;
      }

      const hash = response.eth?.txHash;
      if (
        TERMINAL_SUCCESS_STATUSES.has(response.txStatus) &&
        hash !== undefined &&
        hash !== ""
      ) {
        return hash as Hex;
      }
    } catch (error) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey Sponsorship] getSendTransactionStatus failed",
        error,
        {
          service: "turnkey",
          send_transaction_status_id: sendTransactionStatusId,
        }
      );
      return null;
    }

    await sleep(STATUS_POLL_INTERVAL_MS);
  }

  logSystemError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[Turnkey Sponsorship] Timed out waiting for tx hash",
    new Error(`No txHash within ${STATUS_POLL_TIMEOUT_MS}ms`),
    {
      service: "turnkey",
      send_transaction_status_id: sendTransactionStatusId,
    }
  );
  return null;
}
