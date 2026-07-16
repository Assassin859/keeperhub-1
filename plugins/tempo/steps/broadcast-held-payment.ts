import "server-only";

import {
  claimHeldPayment,
  getHeldPaymentForOrg,
  markConfirmed,
  markFailed,
} from "@/lib/tempo/held-payments";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getErrorMessage } from "@/lib/utils";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { broadcastStoredTempoTx } from "./tempo-tx-core";
import { buildTempoTxLink } from "./tempo-step-helpers";

export type BroadcastHeldPaymentInput = StepInput & {
  paymentId: string;
};

export type BroadcastHeldPaymentResult =
  | {
      success: true;
      paymentId: string;
      transactionHash: string;
      transactionLink: string;
      from: string;
      to: string;
      status: "confirmed";
      chainId: number;
    }
  | { success: false; error: string };

async function stepHandler(
  input: BroadcastHeldPaymentInput
): Promise<BroadcastHeldPaymentResult> {
  const { paymentId, _context } = input;

  if (!paymentId || paymentId.trim() === "") {
    return { success: false, error: "paymentId is required" };
  }
  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo Broadcast Held Payment]",
    "broadcast-held-payment"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const existing = await getHeldPaymentForOrg(paymentId, orgCtx.organizationId);
  if (!existing) {
    return {
      success: false,
      error: `Held payment ${paymentId} was not found for this organization.`,
    };
  }
  if (existing.validBefore <= Math.floor(Date.now() / 1000)) {
    return {
      success: false,
      error:
        "This held payment's validity window has closed; it can no longer be broadcast.",
    };
  }

  // The guarded claim is the single choke point: if another release (UI,
  // poller, or a concurrent run) already claimed this row, we get null and
  // no-op, so the payment can never be broadcast twice.
  const claimed = await claimHeldPayment(paymentId, orgCtx.organizationId);
  if (!claimed) {
    return {
      success: false,
      error: `Held payment ${paymentId} is not pending (status: ${existing.status}); it cannot be broadcast.`,
    };
  }

  try {
    const { hash } = await broadcastStoredTempoTx({
      chainId: claimed.chainId,
      userId: orgCtx.userId,
      serialized: claimed.serializedTx,
      expectedHash: claimed.precomputedHash,
      waitForConfirmation: true,
    });
    await markConfirmed(claimed.id, hash);
    const transactionLink = await buildTempoTxLink(claimed.chainId, hash);
    return {
      success: true,
      paymentId: claimed.id,
      transactionHash: hash,
      transactionLink,
      from: claimed.fromAddress,
      to: claimed.toAddress,
      status: "confirmed",
      chainId: claimed.chainId,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    await markFailed(claimed.id, message);
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Tempo Broadcast Held Payment] broadcast failed",
      error,
      { plugin_name: "tempo", action_name: "broadcast-held-payment" }
    );
    return { success: false, error: message };
  }
}

export async function broadcastHeldPaymentStep(
  input: BroadcastHeldPaymentInput
): Promise<BroadcastHeldPaymentResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "tempo",
      actionName: "broadcast-held-payment",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

broadcastHeldPaymentStep.maxRetries = 0;

export const _integrationType = "tempo";
