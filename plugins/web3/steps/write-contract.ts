import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { withStepValueCap } from "@/lib/execute/value-ledger";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  applyFailOnError,
  type WriteContractCoreInput,
  type WriteContractResult,
  writeContractCore,
} from "./write-contract-core";

export type WriteContractInput = StepInput &
  WriteContractCoreInput & {
    // Mirrors HTTP Request's failOnError. Defaults to true. When false, a
    // failure encountered while attempting the on-chain send (signer init,
    // broadcast, revert) is softened into a success carrying `error` instead
    // of failing the step, so the workflow continues. See
    // applyFailOnError in write-contract-core.ts for exactly which failures
    // qualify.
    failOnError?: boolean;
  };

/**
 * Write Contract Step
 * Writes data to a smart contract using state-changing functions
 */
export async function writeContractStep(
  input: WriteContractInput
): Promise<WriteContractResult> {
  "use step";

  // Enrich input with contract address explorer link for the execution log
  let enrichedInput: WriteContractInput & { contractAddressLink?: string } =
    input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const contractAddressLink = getAddressUrl(
        explorerConfig,
        input.contractAddress
      );
      if (contractAddressLink) {
        enrichedInput = { ...input, contractAddressLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "write-contract",
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(enrichedInput, async () => {
        // applyFailOnError must run here, after withStepValueCap resolves.
        // The value-cap settle/release decision is keyed on the true
        // success/failure of writeContractCore, so softening the result
        // inside withStepValueCap's run() would settle a reservation for a
        // transaction that actually reverted.
        const result = await withStepValueCap(
          {
            organizationId: input._context?.organizationId,
            stepFunction: "writeContractStep",
            config: { ethValue: input.ethValue },
            executionId: input._context?.executionId,
            valueCapReserved: input._context?.valueCapReserved,
          },
          () => writeContractCore(input)
        );
        return applyFailOnError(result, input.failOnError);
      })
  );
}

writeContractStep.maxRetries = 0;

export const _integrationType = "web3";
