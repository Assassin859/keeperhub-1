import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  type CheckStatusCoreInput,
  type CheckStatusResult,
  checkStatusCore,
} from "./check-status-core";

export type CheckStatusInput = StepInput & CheckStatusCoreInput;

export async function checkStatusStep(
  input: CheckStatusInput
): Promise<CheckStatusResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "check-status",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => checkStatusCore(input))
  );
}

export const _integrationType = "coalition";
