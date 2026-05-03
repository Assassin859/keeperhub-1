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

const UNISWAP_PAYABLE_SWAP_FUNCTIONS: ReadonlySet<string> = new Set([
  "exactInputSingle",
  "exactOutputSingle",
]);

const ZERO_ETH_VALUE_PATTERN = /^0(\.0+)?$/;

type PreflightResult =
  | { ok: true }
  | { ok: false; error: string };

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

// KEEP-408: Uniswap swap functions are `payable` so SwapRouter02 can wrap
// msg.value into WETH internally - but only when tokenIn IS the chain's WETH
// address. Setting ETH Value with any other tokenIn strands the ETH in the
// router (the contract has no way to refund it without an explicit refundETH
// in a multicall, which we don't expose). Catch this before the tx is sent.
function checkUniswapNativeEthPreflight(
  input: ProtocolWriteInput,
  meta: ProtocolMeta,
  ethValue: string | undefined
): PreflightResult {
  const isUniswapSwap =
    meta.protocolSlug === "uniswap" &&
    UNISWAP_PAYABLE_SWAP_FUNCTIONS.has(meta.functionName);
  if (!isUniswapSwap) {
    return { ok: true };
  }
  if (!ethValue) {
    return { ok: true };
  }
  const trimmed = ethValue.trim();
  if (trimmed === "" || ZERO_ETH_VALUE_PATTERN.test(trimmed)) {
    return { ok: true };
  }

  const wrapped = getProtocol("wrapped");
  const wethAddress = wrapped?.contracts.weth?.addresses[input.network];
  if (!wethAddress) {
    return {
      ok: false,
      error: `ETH Value is set but the WETH address for chain "${input.network}" is not registered. Cannot verify that this swap accepts native ETH; remove ETH Value or add WETH for this chain in protocols/wrapped.ts.`,
    };
  }

  const tokenIn = input.tokenIn;
  if (typeof tokenIn !== "string" || tokenIn.trim() === "") {
    return {
      ok: false,
      error:
        "ETH Value is set but Input Token Address is missing. To swap native ETH, set Input Token to the WETH address for this chain.",
    };
  }

  if (tokenIn.trim().toLowerCase() !== wethAddress.toLowerCase()) {
    return {
      ok: false,
      error: `ETH Value is set but Input Token (${tokenIn}) is not the WETH address for chain "${input.network}" (${wethAddress}). To swap native ETH, set Input Token to the WETH address; otherwise the ETH would be stranded in SwapRouter02.`,
    };
  }

  return { ok: true };
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

    const preflight = checkUniswapNativeEthPreflight(input, meta, ethValue);
    if (!preflight.ok) {
      return { success: false, error: preflight.error };
    }

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
