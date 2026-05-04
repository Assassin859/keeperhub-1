import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  type ActivateCoreInput,
  type ActivateResult,
  activateCore,
} from "./activate-core";

export type ActivateInput = StepInput & ActivateCoreInput;

export async function activateStep(
  input: ActivateInput
): Promise<ActivateResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "activate",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => activateCore(input))
  );
}

activateStep.maxRetries = 0;

export const _integrationType = "coalition";
