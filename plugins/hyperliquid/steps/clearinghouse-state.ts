import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, postInfo } from "./info-request-core";

export type ClearinghouseStateCoreInput = {
  user: string;
  dex?: string;
};

export type ClearinghouseStateInput = StepInput & ClearinghouseStateCoreInput;

async function stepHandler(
  input: ClearinghouseStateCoreInput
): Promise<InfoResult> {
  if (!input.user) {
    return { success: false, error: "User address is required" };
  }

  const body: Record<string, unknown> = {
    type: "clearinghouseState",
    user: input.user,
  };
  if (input.dex) {
    body.dex = input.dex;
  }

  return postInfo(body, "clearinghouse-state");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function clearinghouseStateStep(
  input: ClearinghouseStateInput
): Promise<InfoResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "hyperliquid",
      actionName: "clearinghouse-state",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

export const _integrationType = "hyperliquid";
