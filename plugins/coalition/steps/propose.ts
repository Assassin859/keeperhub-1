import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  type ProposeCoreInput,
  type ProposeResult,
  proposeCore,
} from "./propose-core";

export type ProposeInput = StepInput & ProposeCoreInput;

export async function proposeStep(
  input: ProposeInput
): Promise<ProposeResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "propose",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => proposeCore(input))
  );
}

proposeStep.maxRetries = 0;

export const _integrationType = "coalition";
