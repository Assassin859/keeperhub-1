import "server-only";
import "@/protocols";

import {
  type WriteContractCoreInput,
  type WriteContractResult,
  writeContractCore,
} from "@/plugins/web3/steps/write-contract-core";
import { resolveAbi } from "@/lib/abi/cache";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getProtocol } from "@/lib/protocol-registry";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { applyEncodeTransformsNamed } from "@/lib/protocol-encode-transforms";
import {
  type ProtocolMeta,
  resolveProtocolMeta,
} from "./resolve-protocol-meta";

type ProtocolWriteInput = StepInput & {
  network: string;
  contractAddress?: string;
  gasLimitMultiplier?: string;
  // KEEP-137: Private mempool routing (Flashbots Protect). Forwarded to writeContractCore.
  usePrivateMempool?: boolean;
  strict?: boolean;
  _protocolMeta?: string;
  _actionType?: string;
  [key: string]: unknown;
};

function resolveEthValue(
  rawEthValue: unknown,
  abi: string,
  functionName: string,
  protocolSlug: string
): string | undefined {
  if (typeof rawEthValue !== "string" || rawEthValue.trim() === "") {
    return undefined;
  }
  const trimmed = rawEthValue.trim();

  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch {
    return trimmed;
  }
  if (!Array.isArray(parsedAbi)) {
    return trimmed;
  }

  // Drop ethValue when the resolved function is positively non-payable. Form
  // state can retain stale ethValue from a previous configuration (e.g. a
  // WETH.deposit action reconfigured into a Uniswap swap), and the value
  // cannot reach the contract anyway. If the function is missing from the
  // ABI or its mutability is unknown, pass the value through and let
  // writeContractCore surface the existing payable/not-found errors.
  const fn = findAbiFunction(parsedAbi as AbiItem[], functionName);
  if (fn?.stateMutability && fn.stateMutability !== "payable") {
    logUserError(
      ErrorCategory.CONFIGURATION,
      `[Protocol Write] Dropped ethValue for non-payable function '${functionName}' (was '${trimmed}')`,
      undefined,
      {
        plugin_name: "protocol",
        action_name: "protocol-write",
        protocol_slug: protocolSlug,
        function_name: functionName,
        state_mutability: fn.stateMutability,
      }
    );
    return undefined;
  }
  return trimmed;
}

function buildFunctionArgs(
  input: ProtocolWriteInput,
  meta: ProtocolMeta
): string | undefined {
  const protocol = getProtocol(meta.protocolSlug);
  if (!protocol) {
    return undefined;
  }

  const protocolAction = protocol.actions.find(
    (a) => a.function === meta.functionName && a.contract === meta.contractKey
  );

  if (!protocolAction || protocolAction.inputs.length === 0) {
    return undefined;
  }

  const rawInputs = protocolAction.inputs.map((inp) => {
    const raw = input[inp.name];
    if (raw === undefined || raw === "") {
      return { name: inp.name, value: inp.default ?? "" };
    }
    const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    return { name: inp.name, value };
  });

  const actionSlug = protocolAction.slug;
  const transformed = applyEncodeTransformsNamed(
    meta.protocolSlug,
    actionSlug,
    rawInputs
  );

  const args = transformed.map((t) => t.value);
  return JSON.stringify(args);
}

export async function protocolWriteStep(
  input: ProtocolWriteInput
): Promise<WriteContractResult> {
  "use step";

  return await withStepLogging(input, async () => {
    // 1. Resolve protocol metadata from config or action type
    const meta = resolveProtocolMeta(input);
    if (!meta) {
      return {
        success: false,
        error:
          "Invalid _protocolMeta: failed to parse JSON and could not derive from action type",
      };
    }

    // 2. Look up protocol definition from runtime registry
    const protocol = getProtocol(meta.protocolSlug);
    if (!protocol) {
      return {
        success: false,
        error: `Unknown protocol: ${meta.protocolSlug}`,
      };
    }

    // 3. Resolve contract for the selected network
    const contract = protocol.contracts[meta.contractKey];
    if (!contract) {
      return {
        success: false,
        error: `Unknown contract key "${meta.contractKey}" in protocol "${meta.protocolSlug}"`,
      };
    }

    const contractAddress = contract.userSpecifiedAddress
      ? input.contractAddress
      : contract.addresses[input.network];
    if (!contractAddress) {
      return {
        success: false,
        error: contract.userSpecifiedAddress
          ? `Missing contract address for "${meta.contractKey}" in protocol "${meta.protocolSlug}"`
          : `Protocol "${meta.protocolSlug}" contract "${meta.contractKey}" is not deployed on network "${input.network}"`,
      };
    }

    // 4. Resolve ABI (from definition or auto-fetch from explorer)
    let resolvedAbi: string;
    try {
      const abiResult = await resolveAbi({
        contractAddress,
        network: input.network,
        abi: contract.abi,
      });
      resolvedAbi = abiResult.abi;
    } catch (error) {
      return {
        success: false,
        error: `Failed to resolve ABI for contract "${meta.contractKey}" in protocol "${meta.protocolSlug}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 5. Build function arguments from named inputs ordered by action definition
    const functionArgs = buildFunctionArgs(input, meta);

    // 6. Delegate to writeContractCore
    const ethValue = resolveEthValue(
      input.ethValue,
      resolvedAbi,
      meta.functionName,
      meta.protocolSlug
    );

    const coreInput: WriteContractCoreInput = {
      contractAddress,
      network: input.network,
      abi: resolvedAbi,
      abiFunction: meta.functionName,
      functionArgs,
      ethValue,
      gasLimitMultiplier: input.gasLimitMultiplier,
      usePrivateMempool: input.usePrivateMempool,
      strict: input.strict,
      _context: input._context
        ? {
            executionId: input._context.executionId,
          }
        : undefined,
    };

    return await writeContractCore(coreInput);
  });
}

protocolWriteStep.maxRetries = 0;

export const _integrationType = "protocol";
