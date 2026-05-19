import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, postInfo } from "./info-request-core";

export type VaultDetailsCoreInput = {
  vaultAddress: string;
  user?: string;
};

export type VaultDetailsInput = StepInput & VaultDetailsCoreInput;

async function stepHandler(
  input: VaultDetailsCoreInput
): Promise<InfoResult> {
  if (!input.vaultAddress) {
    return { success: false, error: "Vault address is required" };
  }

  const body: Record<string, unknown> = {
    type: "vaultDetails",
    vaultAddress: input.vaultAddress,
  };
  if (input.user) {
    body.user = input.user;
  }

  return postInfo(body, "vault-details");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function vaultDetailsStep(
  input: VaultDetailsInput
): Promise<InfoResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "hyperliquid",
      actionName: "vault-details",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

export const _integrationType = "hyperliquid";
