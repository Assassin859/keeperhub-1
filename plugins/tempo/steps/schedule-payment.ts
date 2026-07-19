import "server-only";

import { ethers } from "ethers";
import type { Hex } from "viem";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  buildTransferWithMemoCall,
  normalizeMemo,
  signAndBroadcastTempoTx,
} from "./tempo-tx-core";
import {
  assertTempoChain,
  buildTempoTxLink,
  parseTimestamp,
  resolveTempoToken,
} from "./tempo-step-helpers";

// v1 broadcasts within the triggering run, so the window bounds inclusion time,
// it does not defer the send. Default the deadline to a short window when unset.
const DEFAULT_WINDOW_SEC = 900; // 15 minutes
// A window closing sooner than this can lapse before the payment is signed,
// broadcast, and included, so reject it upfront instead of letting it time out
// after the receipt wait.
const MIN_INCLUSION_BUFFER_SEC = 60;

export type SchedulePaymentInput = StepInput & {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  amount: string;
  recipientAddress: string;
  memo?: string;
  validAfter?: string;
  validBefore?: string;
};

export type SchedulePaymentResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      from: string;
      to: string;
      amount: string;
      memo: string;
      validAfter: number | null;
      validBefore: number;
      chainId: number;
    }
  | { success: false; error: string };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear guard chain over the payment window
async function stepHandler(
  input: SchedulePaymentInput
): Promise<SchedulePaymentResult> {
  const { network, tokenConfig, amount, recipientAddress, memo, _context } =
    input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
    assertTempoChain(chainId);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!ethers.isAddress(recipientAddress)) {
    return {
      success: false,
      error: `Invalid recipient address: ${recipientAddress}`,
    };
  }
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let validAfterSec: number | undefined;
  let validBeforeSec: number;
  try {
    validAfterSec = parseTimestamp(input.validAfter, nowSec);
    validBeforeSec =
      parseTimestamp(input.validBefore, nowSec) ?? nowSec + DEFAULT_WINDOW_SEC;
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (validBeforeSec < nowSec + MIN_INCLUSION_BUFFER_SEC) {
    return {
      success: false,
      error:
        "The payment window closes too soon: validBefore must be at least 60 seconds ahead so the payment can be signed and settle before it lapses.",
    };
  }
  if (validAfterSec !== undefined && validAfterSec > nowSec) {
    return {
      success: false,
      error:
        "validAfter is in the future. Scheduled payments broadcast during this run, so trigger the workflow within the window; deferred pre-signing is not yet supported.",
    };
  }
  if (validAfterSec !== undefined && validBeforeSec <= validAfterSec) {
    return {
      success: false,
      error: "validBefore must be after validAfter.",
    };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo Scheduled Payment]",
    "schedule-payment"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  try {
    const rpcManager = await getRpcProvider({
      chainId,
      userId: orgCtx.userId,
    });
    const token = await resolveTempoToken(tokenConfig, chainId, rpcManager);
    const amountRaw = ethers.parseUnits(amount, token.decimals);
    const recipient = ethers.getAddress(recipientAddress) as Hex;
    const memoBytes = normalizeMemo(memo);

    const call = buildTransferWithMemoCall(
      token.address,
      recipient,
      amountRaw,
      memoBytes
    );
    const { hash, from } = await signAndBroadcastTempoTx({
      organizationId: orgCtx.organizationId,
      userId: orgCtx.userId,
      chainId,
      calls: [call],
      feeToken: token.address,
      validAfter: validAfterSec,
      validBefore: validBeforeSec,
      executionId: _context?.executionId,
    });

    const transactionLink = await buildTempoTxLink(chainId, hash);
    return {
      success: true,
      transactionHash: hash,
      transactionLink,
      from,
      to: recipient,
      amount,
      memo: memoBytes,
      validAfter: validAfterSec ?? null,
      validBefore: validBeforeSec,
      chainId,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Tempo Scheduled Payment] schedule-payment failed",
      error,
      { plugin_name: "tempo", action_name: "schedule-payment" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function schedulePaymentStep(
  input: SchedulePaymentInput
): Promise<SchedulePaymentResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "tempo",
      actionName: "schedule-payment",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

schedulePaymentStep.maxRetries = 0;

export const _integrationType = "tempo";
