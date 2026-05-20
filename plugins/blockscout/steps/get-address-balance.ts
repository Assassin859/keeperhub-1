import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import type { BlockscoutCredentials } from "../credentials";
import { blockscoutGet } from "./blockscout-core";

type AddressResponse = {
  hash?: string;
  coin_balance?: string;
  is_contract?: boolean;
  ens_domain_name?: string | null;
};

type GetAddressBalanceResult =
  | {
      success: true;
      address: string;
      balance: string;
      isContract: boolean;
      ensName: string | null;
    }
  | { success: false; error: string };

export type GetAddressBalanceCoreInput = {
  address: string;
};

export type GetAddressBalanceInput = StepInput &
  GetAddressBalanceCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetAddressBalanceCoreInput,
  credentials: BlockscoutCredentials
): Promise<GetAddressBalanceResult> {
  const address = input.address?.trim();
  if (!address) {
    return { success: false, error: "Address is required." };
  }

  const result = await blockscoutGet<AddressResponse>(
    `/api/v2/addresses/${encodeURIComponent(address)}`,
    credentials
  );

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    address: result.data.hash ?? address,
    balance: result.data.coin_balance ?? "0",
    isContract: result.data.is_contract ?? false,
    ensName: result.data.ens_domain_name ?? null,
  };
}

export async function getAddressBalanceStep(
  input: GetAddressBalanceInput
): Promise<GetAddressBalanceResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withPluginMetrics(
    {
      pluginName: "blockscout",
      actionName: "get-address-balance",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input, credentials))
  );
}

export const _integrationType = "blockscout";
