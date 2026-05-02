import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type SlashCoreInput, type SlashResult, slashCore } from "./slash-core";

export type SlashInput = StepInput & SlashCoreInput;

export async function slashStep(input: SlashInput): Promise<SlashResult> {
  "use step";
  return withPluginMetrics(
    {
      pluginName: "coalition",
      actionName: "slash",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => slashCore(input))
  );
}

slashStep.maxRetries = 0;

export const _integrationType = "coalition";
