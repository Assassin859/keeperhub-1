import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type SignCoreInput, type SignResult, signCore } from "./sign-core";

export type SignInput = StepInput & SignCoreInput;

export async function signStep(input: SignInput): Promise<SignResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "sign",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => signCore(input))
  );
}

signStep.maxRetries = 0;

export const _integrationType = "coalition";
