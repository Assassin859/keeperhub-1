import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  type ExpireCoreInput,
  type ExpireResult,
  expireCore,
} from "./expire-core";

export type ExpireInput = StepInput & ExpireCoreInput;

export async function expireStep(input: ExpireInput): Promise<ExpireResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "expire",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => expireCore(input))
  );
}

expireStep.maxRetries = 0;

export const _integrationType = "coalition";
