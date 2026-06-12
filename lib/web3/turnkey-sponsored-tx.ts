import "server-only";
import { getAddress, type Hex } from "viem";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";
import {
  formatRevertChain,
  type RevertChainEntry,
  SponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";
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

// Turnkey's getSendTransactionStatus returns short status strings
// (INITIALIZED, BROADCASTING, BROADCASTED, INCLUDED, CONFIRMED, FINALIZED,
// FAILED, DROPPED, REJECTED), NOT the `TRANSACTION_STATUS_*` enum the API uses
// elsewhere -- the original constants never matched, so the poll always timed
// out and callers fell back to direct signing. Turnkey reports INCLUDED only
// once the tx succeeded on-chain and FAILED for reverts, so matching the real
// terminal states keeps revert detection (SponsoredTxRevertError) intact.
const TERMINAL_FAILURE_STATUSES = new Set([
  "FAILED",
  "DROPPED",
  "REJECTED",
  "TIMEOUT",
  "REVERTED",
]);

const TERMINAL_SUCCESS_STATUSES = new Set([
  "BROADCASTED",
  "INCLUDED",
  "CONFIRMED",
  "FINALIZED",
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
      // Turnkey matches the signing resource on the EIP-55 checksummed address
      // (it is case-sensitive). The wallet address is stored lowercase in the
      // DB, so checksum it here or Turnkey rejects with "Could not find any
      // resource to sign with" and the caller falls back to direct signing.
      from: getAddress(params.walletAddress),
      sponsor: true,
      // Turnkey confirmed Arbitrum (eip155:42161) is supported on mainnet,
      // but the SDK v5.2.0 CAIP-2 enum has not been regenerated yet. Widen
      // the type until the SDK catches up; remove this cast once the enum
      // includes 42161.
      // biome-ignore lint/suspicious/noExplicitAny: SDK CAIP-2 enum lags Turnkey's confirmed chain coverage
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
    let response: Awaited<ReturnType<typeof client.getSendTransactionStatus>>;
    try {
      response = await client.getSendTransactionStatus({
        organizationId: subOrgId,
        sendTransactionStatusId,
      });
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

    const hash = response.eth?.txHash;
    const hasFailure =
      TERMINAL_FAILURE_STATUSES.has(response.txStatus) ||
      Boolean(response.txError) ||
      Boolean(response.error);

    if (hasFailure) {
      // Post-broadcast revert: txHash is set, the underlying call is already
      // on-chain. Throw a typed error carrying Turnkey's structured revert
      // chain so callers can surface the real revert reason and skip the
      // direct-signing fallback (which would just revert again).
      if (hash !== undefined && hash !== "") {
        const revertChain = (response.error?.eth?.revertChain ??
          []) as readonly RevertChainEntry[];
        const message = response.txError ?? formatRevertChain(revertChain);
        throw new SponsoredTxRevertError({
          message,
          txHash: hash as Hex,
          sendTransactionStatusId,
          revertChain,
        });
      }

      // Pre-broadcast failure (policy denial, gas-cap exhaustion, simulation
      // error). Nothing happened on-chain; return null so the caller falls
      // back to direct signing.
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey Sponsorship] Transaction terminated before broadcast",
        new Error(response.txError ?? response.txStatus),
        {
          service: "turnkey",
          send_transaction_status_id: sendTransactionStatusId,
          tx_status: response.txStatus,
        }
      );
      return null;
    }

    if (
      TERMINAL_SUCCESS_STATUSES.has(response.txStatus) &&
      hash !== undefined &&
      hash !== ""
    ) {
      return hash as Hex;
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
