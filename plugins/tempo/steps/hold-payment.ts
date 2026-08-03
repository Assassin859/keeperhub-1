import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  type BroadcastMode,
  executeHoldPayment,
  type HoldPaymentCoreResult,
} from "./hold-payment-core";

export type HoldPaymentInput = StepInput & {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  amount: string;
  recipientAddress: string;
  memo?: string;
  broadcastMode?: BroadcastMode;
  broadcastAt?: string;
  validBefore?: string;
};

export type HoldPaymentResult = HoldPaymentCoreResult;

async function stepHandler(
  input: HoldPaymentInput
): Promise<HoldPaymentResult> {
  const { _context } = input;

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo Hold Payment]",
    "hold-payment"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  return executeHoldPayment({
    organizationId: orgCtx.organizationId,
    userId: orgCtx.userId,
    network: input.network,
    tokenConfig: input.tokenConfig,
    amount: input.amount,
    recipientAddress: input.recipientAddress,
    memo: input.memo,
    broadcastMode: input.broadcastMode,
    broadcastAt: input.broadcastAt,
    validBefore: input.validBefore,
    workflowId: _context?.workflowId,
    executionId: _context?.executionId,
  });
}

export async function holdPaymentStep(
  input: HoldPaymentInput
): Promise<HoldPaymentResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "tempo",
      actionName: "hold-payment",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

holdPaymentStep.maxRetries = 0;

export const _integrationType = "tempo";
