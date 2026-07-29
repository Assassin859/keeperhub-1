import "server-only";

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toChecksumAddress } from "@/lib/address-utils";
import { USDC_BASE_ADDRESS } from "@/lib/agentic-wallet/constants";
import {
  type EIP712TypedData,
  signTypedDataWithTurnkey,
} from "@/lib/agentic-wallet/sign-typed-data";
import { facilitatorClient } from "@/lib/payments/x402/server";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";
import { getPaygConfig } from "./config-store";
import {
  evmNetworkId,
  PAYG_PAYMENT_STATUS,
  PAYG_RESOURCE_URL,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  X402_EXACT_SCHEME,
} from "./constants";
import type { PaygBlockReason } from "./errors";
import {
  findPaygPayment,
  getPaygSpentRaw,
  recordPaygPayment,
} from "./payments";
import { getPaygPeriod, startOfUtcDay } from "./period";
import { getPaygExecutionPriceRaw } from "./pricing";
import { getPaygTreasuryOrNull } from "./treasury";

export type AutopayResult =
  | { ok: true; txHash: string; amountRaw: bigint }
  | { ok: false; reason: PaygBlockReason };

// The facilitator settle response shape we depend on (from @x402). Kept local
// so a minor SDK response change surfaces here rather than deep in a call.
type SettleLike = {
  success?: boolean;
  transaction?: string;
  errorReason?: string;
};

function classifySettleFailure(reason: string): PaygBlockReason {
  const lower = reason.toLowerCase();
  if (
    lower.includes("insufficient") ||
    lower.includes("balance") ||
    lower.includes("funds")
  ) {
    return "insufficient_funds";
  }
  return "payment_failed";
}

/**
 * Settle `amountRaw` USDC from the org wallet to the treasury via the x402
 * facilitator (gasless: the facilitator submits the EIP-3009
 * transferWithAuthorization on-chain and pays gas). The org Turnkey key signs
 * the authorization; nothing is charged to the org for gas.
 *
 * NOTE: the on-chain settlement path requires the facilitator API keys and can
 * only be validated end-to-end on a testnet, not in unit/local runs.
 */
async function settleViaFacilitator(params: {
  subOrgId: string;
  payerAddress: string;
  treasury: string;
  amountRaw: bigint;
  chainId: number;
}): Promise<
  { ok: true; txHash: string } | { ok: false; reason: PaygBlockReason }
> {
  const clientSigner: ClientEvmSigner = {
    address: params.payerAddress as `0x${string}`,
    signTypedData: (message) =>
      signTypedDataWithTurnkey(
        params.subOrgId,
        params.payerAddress,
        message as EIP712TypedData
      ).then((signature) => signature as `0x${string}`),
  };

  const resource = {
    url: PAYG_RESOURCE_URL,
    description: "Pay-as-you-go execution",
    mimeType: "application/json",
  };
  const requirements = {
    scheme: X402_EXACT_SCHEME,
    network: evmNetworkId(params.chainId),
    amount: params.amountRaw.toString(),
    asset: USDC_BASE_ADDRESS,
    payTo: params.treasury,
    maxTimeoutSeconds: 300,
    extra: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION },
  } as PaymentRequirements;

  try {
    // The exact scheme signs the EIP-3009 authorization and returns only
    // { x402Version, payload }. The facilitator's v2 settle schema needs the
    // complete payment payload, so wrap it with the accepted requirements and
    // resource, exactly as the x402 client assembles it.
    const partial = (await new ExactEvmScheme(
      clientSigner
    ).createPaymentPayload(2, requirements)) as unknown as {
      x402Version: number;
      payload: Record<string, unknown>;
    };
    const paymentPayload = {
      x402Version: partial.x402Version,
      payload: partial.payload,
      resource,
      accepted: requirements,
    } as unknown as PaymentPayload;
    const settle = (await facilitatorClient.settle(
      paymentPayload,
      requirements
    )) as SettleLike;
    if (!(settle.success && settle.transaction)) {
      return {
        ok: false,
        reason: classifySettleFailure(settle.errorReason ?? "unknown"),
      };
    }
    return { ok: true, txHash: settle.transaction };
  } catch (error) {
    return {
      ok: false,
      reason: classifySettleFailure(
        error instanceof Error ? error.message : String(error)
      ),
    };
  }
}

/**
 * Charge one PAYG execution: enforce the daily + period spend caps, settle the
 * per-execution price to the treasury, and record the payment. Returns the
 * block reason instead of throwing so the caller can surface a clear message
 * and record it on the run.
 */
export async function autopayForExecution(params: {
  organizationId: string;
  executionId: string;
}): Promise<AutopayResult> {
  const { organizationId, executionId } = params;

  const config = await getPaygConfig(organizationId);
  if (!config) {
    return { ok: false, reason: "not_eligible" };
  }

  // Idempotency: a redelivered run must not settle a second on-chain transfer.
  // If this execution was already paid, return the recorded tx unchanged.
  const existing = await findPaygPayment(organizationId, executionId);
  if (existing?.txHash) {
    return {
      ok: true,
      txHash: existing.txHash,
      amountRaw: BigInt(existing.amountRaw),
    };
  }

  const priceRaw = getPaygExecutionPriceRaw();
  const treasury = getPaygTreasuryOrNull(config.chainId);
  if (priceRaw <= BigInt(0) || !treasury) {
    return { ok: false, reason: "not_eligible" };
  }

  const dailyCapRaw = BigInt(config.dailyCapRaw);
  if (dailyCapRaw > BigInt(0)) {
    const spentToday = await getPaygSpentRaw(organizationId, startOfUtcDay());
    if (spentToday + priceRaw > dailyCapRaw) {
      return { ok: false, reason: "daily_cap" };
    }
  }

  const periodCapRaw = BigInt(config.periodCapRaw);
  if (periodCapRaw > BigInt(0)) {
    const period = getPaygPeriod(config.startedAt);
    const spentPeriod = await getPaygSpentRaw(
      organizationId,
      period.start,
      period.end
    );
    if (spentPeriod + priceRaw > periodCapRaw) {
      return { ok: false, reason: "period_cap" };
    }
  }

  const wallet = await getOrganizationWallet(organizationId).catch(() => null);
  if (!wallet?.turnkeySubOrgId) {
    return { ok: false, reason: "not_eligible" };
  }

  const settlement = await settleViaFacilitator({
    subOrgId: wallet.turnkeySubOrgId,
    // Turnkey's signWith lookup is case-sensitive; the org wallet is stored
    // lowercase, so checksum it before signing with our own wallet.
    payerAddress: toChecksumAddress(wallet.walletAddress),
    treasury,
    amountRaw: priceRaw,
    chainId: config.chainId,
  });
  if (!settlement.ok) {
    return { ok: false, reason: settlement.reason };
  }

  await recordPaygPayment({
    organizationId,
    executionId,
    amountRaw: priceRaw.toString(),
    txHash: settlement.txHash,
    chainId: config.chainId,
    payerAddress: wallet.walletAddress,
    treasuryAddress: treasury,
    status: PAYG_PAYMENT_STATUS.settled,
  });

  return { ok: true, txHash: settlement.txHash, amountRaw: priceRaw };
}
