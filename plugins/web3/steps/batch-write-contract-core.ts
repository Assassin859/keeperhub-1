/**
 * Core batch-write-contract logic. No "use step" directive: this file exists
 * so the step file can reuse validation/encoding/decoding logic without
 * exporting helpers from a "use step" file (which breaks the workflow
 * bundler, see plugins/CLAUDE.md).
 *
 * Sends N state-changing calls to potentially different contracts as one
 * atomic transaction via the already-deployed Multicall3 contract's
 * aggregate3(Call3[]) function. Unlike batch-read-contract.ts, which calls
 * aggregate3 via .staticCall for a free read, this broadcasts aggregate3 as
 * a real signed transaction, confirmed payable (not view) in
 * lib/contracts/abis/multicall3.json.
 */
import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { validateArgsForAbi } from "@/lib/abi/validate-args";
import { findAbiFunction } from "@/lib/abi/utils";
import { getAbiFunctionKey } from "@/lib/abi/function-key";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import { getErrorMessage, resolveFailOnError } from "@/lib/utils";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/web3/wallet-helpers";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import {
  classifyRevert,
  formatContractError,
  type RevertKind,
} from "@/lib/web3/decode-revert-error";
import {
  parsePriorityFeeGwei,
  resolveGasLimitOverrides,
} from "@/lib/web3/gas-defaults";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import type { TransactionContext } from "@/lib/web3/transaction-manager";
import { withNonceSession } from "@/lib/web3/transaction-manager";
import { generateId } from "@/lib/utils/id";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

// Write batches are gas-bound, not RPC-payload-bound (unlike batch-read's
// 5000-call ceiling). A much lower cap here avoids wasting validation work
// on batches that could never fit inside a block.
const MAX_TOTAL_CALLS = 200;

export type BatchWriteCallResult = {
  success: boolean;
  result?: unknown;
  error?: string;
};

export type BatchWriteContractCoreInput = {
  network: string;
  abi: string;
  abiFunction: string;
  calls: string; // JSON: [{ contractAddress: string, args?: unknown[] }, ...]
  isolateCallFailures?: string; // "true" (default) or "false"
  gasLimitMultiplier?: string;
  priorityFeeGwei?: string;
  usePrivateMempool?: boolean;
  strict?: boolean;
  web3Connection?: string;
  _context?: { executionId?: string; organizationId?: string };
};

export type BatchWriteContractResult =
  | {
      success: true;
      transactionHash?: string;
      chainId?: number;
      transactionLink?: string;
      gasUsed?: string;
      gasUsedUnits?: string;
      effectiveGasPrice?: string;
      results?: BatchWriteCallResult[];
      totalCalls?: number;
      // Present only when failOnError=false softened an execution failure
      // into success (see applyBatchFailOnError). Absent on a genuine
      // successful broadcast.
      error?: string;
      rejection?: RevertKind;
    }
  | {
      success: false;
      error: string;
      rejection?: RevertKind;
      errorClass?: ExecutionErrorType;
      transactionHash?: string;
      chainId?: number;
    };

/**
 * Soften an execution failure into a success value when failOnError=false, so
 * the workflow continues past a signer/RPC failure or a whole-batch revert
 * instead of aborting. This is a local copy of applyFailOnError in
 * write-contract-core.ts (same rationale: only failures with no errorClass,
 * meaning the actual attempt to broadcast, are eligible; USER/SYSTEM
 * configuration failures always hard-fail). Duplicated rather than imported
 * because write-contract-core.ts's version is nominally typed against
 * WriteContractResult, which would drop `results`/`totalCalls` from the
 * return type if reused here.
 */
export function applyBatchFailOnError(
  result: BatchWriteContractResult,
  failOnError: unknown
): BatchWriteContractResult {
  if (result.success || result.errorClass || resolveFailOnError(failOnError)) {
    return result;
  }
  return {
    success: true,
    error: redactAllUrls(result.error),
    rejection: result.rejection,
  };
}

/** Recursively convert BigInt values to strings without a JSON round-trip. */
function serializeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeBigInts);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeBigInts(v);
    }
    return out;
  }
  return value;
}

/** Decode a single aggregate3 Result entry against the batch's shared function. */
function decodeAggregate3Entry(
  callSuccess: boolean,
  returnData: string,
  iface: ethers.Interface,
  functionKey: string,
  outputs: AbiOutputParam[]
): BatchWriteCallResult {
  if (!callSuccess) {
    let revertReason = "Call reverted";
    try {
      const decoded = iface.parseError(returnData);
      if (decoded) {
        revertReason = `Call reverted: ${decoded.name}(${decoded.args.join(", ")})`;
      }
    } catch {
      if (returnData && returnData !== "0x") {
        try {
          const reason = ethers.AbiCoder.defaultAbiCoder().decode(
            ["string"],
            ethers.dataSlice(returnData, 4)
          );
          revertReason = `Call reverted: ${reason[0]}`;
        } catch {
          // Raw bytes, no decodable reason
        }
      }
    }
    return { success: false, result: undefined, error: revertReason };
  }

  try {
    const decoded = iface.decodeFunctionResult(functionKey, returnData);
    const serialized = serializeBigInts(decoded);
    const structured =
      outputs.length > 0
        ? structureAbiOutputs(
            Array.isArray(serialized) ? serialized : [serialized],
            outputs
          )
        : serialized;
    return { success: true, result: structured };
  } catch (error) {
    return {
      success: false,
      result: undefined,
      error: `Failed to decode result: ${getErrorMessage(error)}`,
    };
  }
}

type ParsedCall = { contractAddress: string; args: unknown[] };

/**
 * Parse, validate, and coerce the `calls` JSON against the batch's shared
 * function ABI. Fails fast on the first invalid entry (matches
 * batch-read-contract.ts's buildMixedCalls convention).
 */
function validateAndParseCalls(
  callsJson: string,
  // biome-ignore lint/suspicious/noExplicitAny: ethers ABI fragment shape, mirrors write-contract-core's functionAbi typing
  functionAbi: any
): { calls: ParsedCall[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(callsJson);
  } catch (error) {
    return { calls: [], error: `Invalid Calls JSON: ${getErrorMessage(error)}` };
  }

  if (!Array.isArray(parsed)) {
    return { calls: [], error: "Calls must be a JSON array" };
  }
  if (parsed.length === 0) {
    return { calls: [], error: "Calls must contain at least one entry" };
  }
  if (parsed.length > MAX_TOTAL_CALLS) {
    return {
      calls: [],
      error: `Too many calls (${parsed.length}). Maximum is ${MAX_TOTAL_CALLS}.`,
    };
  }

  const calls: ParsedCall[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { calls: [], error: `Call at index ${index} must be an object` };
    }
    const typedEntry = entry as Record<string, unknown>;
    const contractAddress = typedEntry.contractAddress;
    if (typeof contractAddress !== "string" || !contractAddress) {
      return {
        calls: [],
        error: `Call at index ${index} missing contractAddress`,
      };
    }
    if (!ethers.isAddress(contractAddress)) {
      return {
        calls: [],
        error: `Call at index ${index} has invalid address: ${contractAddress}`,
      };
    }
    const rawArgs = typedEntry.args;
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      return {
        calls: [],
        error: `Call at index ${index}: args must be an array`,
      };
    }
    let args: unknown[] = Array.isArray(rawArgs) ? rawArgs : [];
    try {
      args = reshapeArgsForAbi(args, functionAbi);
      args = coerceArgsForAbi(args, functionAbi);
      const validation = validateArgsForAbi(args, functionAbi);
      if (!validation.ok) {
        return {
          calls: [],
          error: `Call at index ${index}: ${validation.error}`,
        };
      }
    } catch (error) {
      return {
        calls: [],
        error: `Call at index ${index}: ${getErrorMessage(error)}`,
      };
    }
    calls.push({ contractAddress, args });
  }

  return { calls };
}

type Call3 = { target: string; allowFailure: boolean; callData: string };

/** Encode each parsed call's calldata against the batch's shared interface. */
function encodeCall3Array(
  calls: ParsedCall[],
  iface: ethers.Interface,
  functionKey: string,
  allowFailure: boolean
): { call3Array: Call3[]; error?: string } {
  const call3Array: Call3[] = [];
  for (const [index, call] of calls.entries()) {
    try {
      const callData = iface.encodeFunctionData(functionKey, call.args);
      call3Array.push({ target: call.contractAddress, allowFailure, callData });
    } catch (error) {
      return {
        call3Array: [],
        error: `Failed to encode call at index ${index}: ${getErrorMessage(error)}`,
      };
    }
  }
  return { call3Array };
}

async function getWorkflowIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }
  try {
    const execution = await db
      .select({ workflowId: workflowExecutions.workflowId })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .then((rows) => rows[0]);
    return execution?.workflowId ?? undefined;
  } catch {
    // Non-critical: workflowId is optional for tracking
    return;
  }
}

/**
 * Core batch write contract logic. Sends N calls to Multicall3's aggregate3
 * as a single atomic transaction, isolating per-call failures according to
 * `isolateCallFailures`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contract interaction requires extensive validation, mirrors write-contract-core.ts
export async function batchWriteContractCore(
  input: BatchWriteContractCoreInput
): Promise<BatchWriteContractResult> {
  const {
    network,
    abi,
    abiFunction,
    calls,
    isolateCallFailures,
    gasLimitMultiplier,
    priorityFeeGwei,
    usePrivateMempool,
    strict,
    web3Connection,
    _context,
  } = input;

  if (!abiFunction || abiFunction.trim() === "") {
    return {
      success: false,
      error: "Missing `abiFunction` in the step config",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);
  const priorityFeeOverride = parsePriorityFeeGwei(priorityFeeGwei);

  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch (error) {
    return {
      success: false,
      error: `Invalid ABI JSON: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }
  if (!Array.isArray(parsedAbi)) {
    return {
      success: false,
      error: "ABI must be a JSON array",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const functionAbi = findAbiFunction(parsedAbi, abiFunction);
  if (!functionAbi) {
    return {
      success: false,
      error: `Function '${abiFunction}' not found in ABI`,
      errorClass: ExecutionErrorType.USER,
    };
  }
  const abiFunctionKey = getAbiFunctionKey(parsedAbi, abiFunction, functionAbi);

  const { calls: parsedCalls, error: callsError } = validateAndParseCalls(
    calls,
    functionAbi
  );
  if (callsError) {
    return { success: false, error: callsError, errorClass: ExecutionErrorType.USER };
  }

  const iface = new ethers.Interface(parsedAbi as ethers.InterfaceAbi);
  const allowFailure = isolateCallFailures !== "false";
  const { call3Array, error: encodeError } = encodeCall3Array(
    parsedCalls,
    iface,
    abiFunctionKey,
    allowFailure
  );
  if (encodeError) {
    return { success: false, error: encodeError, errorClass: ExecutionErrorType.USER };
  }

  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Batch Write Contract]",
    "batch-write-contract"
  );
  if (!orgCtx.success) {
    return { success: false, error: orgCtx.error, errorClass: ExecutionErrorType.SYSTEM };
  }
  const { organizationId, userId } = orgCtx;

  let chainId: number;
  let rpcUrl: string;
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    chainId = getChainIdFromNetwork(network);
    rpcManager = await getRpcProvider({ chainId, userId, usePrivateMempool, strict });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }

  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }

  let signerMode: Awaited<ReturnType<typeof resolveSignerForNode>>;
  try {
    signerMode = await resolveSignerForNode({ organizationId, chainId, web3Connection });
  } catch (error) {
    return {
      success: false,
      error: `Failed to resolve Web3 Connection: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }
  if (signerMode.kind !== SIGNER_MODE.EOA) {
    return {
      success: false,
      error:
        "Batch Write Contract only supports the default EOA Web3 Connection. Safe/Role routing would change msg.sender for every batched call, which is not supported here. Use individual Write Contract nodes for Safe execution instead.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Pre-broadcast simulation: aggregate3 has no equivalent to a transaction
  // receipt's decoded return data, so this is the only way to get per-call
  // success/result/error before, and immediately preceding, the real send.
  let aggregateResults: [boolean, string][];
  try {
    aggregateResults = await rpcManager.executeWithFailover(
      (provider) =>
        new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider)
          .aggregate3.staticCall(call3Array) as Promise<[boolean, string][]>
    );
  } catch (error) {
    const rejection = classifyRevert(error, iface);
    return {
      success: false,
      error: formatContractError(error, iface),
      ...(rejection.kind !== "unknown" ? { rejection } : {}),
    };
  }

  const outputs = (functionAbi as { outputs?: AbiOutputParam[] }).outputs ?? [];
  const results = aggregateResults.map(([ok, data]) =>
    decodeAggregate3Entry(ok, data, iface, abiFunctionKey, outputs)
  );

  const workflowId =
    _context?.executionId && !_context?.organizationId
      ? await getWorkflowIdFromExecution(_context.executionId)
      : undefined;

  const txContext: TransactionContext = {
    organizationId,
    executionId: _context?.executionId ?? `direct-${generateId()}`,
    workflowId,
    chainId,
    rpcUrl,
    rpcManager,
  };

  const adapter = getChainAdapter(chainId);

  return withNonceSession(txContext, walletAddress, async (session) => {
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    try {
      const receipt = await adapter.executeContractCall(
        signer,
        {
          contractAddress: MULTICALL3_ADDRESS,
          abi: MULTICALL3_ABI,
          functionKey: "aggregate3",
          args: [call3Array],
        },
        session,
        {
          gasOverrides: { multiplierOverride, gasLimitOverride, priorityFeeOverride },
          workflowId,
          rpcManager,
        }
      );

      const gasUsedUnits = receipt.gasUsed.toString();
      const effectiveGasPrice = receipt.effectiveGasPrice.toString();
      const gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);

      return {
        success: true,
        transactionHash: receipt.hash,
        chainId,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
        results,
        totalCalls: results.length,
      };
    } catch (error) {
      const rejection = classifyRevert(error, iface);
      return {
        success: false,
        error: formatContractError(error, iface),
        ...(rejection.kind !== "unknown" ? { rejection } : {}),
      };
    }
  });
}
