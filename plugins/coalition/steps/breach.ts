import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  type BreachCoreInput,
  type BreachResult,
  breachCore,
} from "./breach-core";

export type BreachInput = StepInput & BreachCoreInput;

export async function breachStep(input: BreachInput): Promise<BreachResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "breach",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => breachCore(input))
  );
}

breachStep.maxRetries = 0;

export const _integrationType = "coalition";
