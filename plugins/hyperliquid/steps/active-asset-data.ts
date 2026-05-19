import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, postInfo } from "./info-request-core";

export type ActiveAssetDataCoreInput = {
  user: string;
  coin: string;
};

export type ActiveAssetDataInput = StepInput & ActiveAssetDataCoreInput;

async function stepHandler(
  input: ActiveAssetDataCoreInput
): Promise<InfoResult> {
  if (!input.user) {
    return { success: false, error: "User address is required" };
  }
  if (!input.coin) {
    return { success: false, error: "Coin is required" };
  }

  return postInfo(
    { type: "activeAssetData", user: input.user, coin: input.coin },
    "active-asset-data"
  );
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function activeAssetDataStep(
  input: ActiveAssetDataInput
): Promise<InfoResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "hyperliquid",
      actionName: "active-asset-data",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

export const _integrationType = "hyperliquid";
