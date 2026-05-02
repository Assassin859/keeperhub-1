import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  type DissolveCoreInput,
  type DissolveResult,
  dissolveCore,
} from "./dissolve-core";

export type DissolveInput = StepInput & DissolveCoreInput;

export async function dissolveStep(
  input: DissolveInput
): Promise<DissolveResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "dissolve",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => dissolveCore(input))
  );
}

dissolveStep.maxRetries = 0;

export const _integrationType = "coalition";
