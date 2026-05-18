import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import type {
  SignTypedDataCoreInput,
  SignTypedDataResult,
} from "./sign-typed-data-core";
import { signTypedDataCore } from "./sign-typed-data-core";

export type { SignTypedDataResult } from "./sign-typed-data-core";

export type SignTypedDataInput = StepInput & SignTypedDataCoreInput;

/**
 * Sign Typed Data (EIP-712) Step
 * Produces a 65-byte secp256k1 signature over an EIP-712 typed-data object
 * using the organization's Turnkey-backed wallet. Suitable for x402 /
 * EIP-3009 transferWithAuthorization, MPP proofs, EIP-2612 permits, and
 * arbitrary protocol intents that need an off-chain signature destined for
 * an HTTP body or contract argument.
 */
export async function signTypedDataStep(
  input: SignTypedDataInput
): Promise<SignTypedDataResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "sign-typed-data",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => signTypedDataCore(input))
  );
}

// Security-critical: do not auto-retry a signing call. A retried sign
// produces a fresh signature (different IV-equivalent randomness inside
// Turnkey) which the caller's downstream HTTP retry may double-spend.
signTypedDataStep.maxRetries = 0;

export const _integrationType = "web3";
