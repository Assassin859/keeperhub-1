import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import type {
  CallSolanaProgramCoreInput,
  CallSolanaProgramResult,
} from "./call-solana-program-core";
import { callSolanaProgramCore } from "./call-solana-program-core";

export type {
  CallSolanaProgramCoreInput,
  CallSolanaProgramResult,
} from "./call-solana-program-core";

export type CallSolanaProgramInput = StepInput & CallSolanaProgramCoreInput;

/**
 * Call Solana Program (Anchor) Step
 * Encodes and submits an Anchor program instruction from a fetched or pasted
 * IDL, signed by the organization wallet.
 */
export async function callSolanaProgramStep(
  input: CallSolanaProgramInput
): Promise<CallSolanaProgramResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "call-solana-program-anchor",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => callSolanaProgramCore(input))
  );
}

callSolanaProgramStep.maxRetries = 0;

export const _integrationType = "web3";
