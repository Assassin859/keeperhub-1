import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, postInfo } from "./info-request-core";

export type SubAccountsCoreInput = {
  user: string;
};

export type SubAccountsInput = StepInput & SubAccountsCoreInput;

async function stepHandler(input: SubAccountsCoreInput): Promise<InfoResult> {
  if (!input.user) {
    return { success: false, error: "Master address is required" };
  }

  return postInfo({ type: "subAccounts", user: input.user }, "sub-accounts");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function subAccountsStep(
  input: SubAccountsInput
): Promise<InfoResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "hyperliquid",
      actionName: "sub-accounts",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

export const _integrationType = "hyperliquid";
