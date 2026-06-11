import { HttpStatus } from "@/lib/http-status";
import "server-only";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi/cache";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { simulateContractCall } from "@/lib/execute/simulate";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { getErrorMessage } from "@/lib/utils";
import { readContractCore } from "@/plugins/web3/steps/read-contract-core";
import { writeContractCore } from "@/plugins/web3/steps/write-contract-core";
import { validateApiKey } from "../_lib/auth";
import {
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { parseSimulateFlag } from "../_lib/simulate-flag";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import { validateContractCallInput } from "../_lib/validate";
import { requireWallet } from "../_lib/wallet-check";

function findFunctionInAbi(
  abi: string,
  functionName: string
): { entry: AbiItem } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(abi);
  } catch {
    return { error: "Invalid ABI JSON" };
  }

  if (!Array.isArray(parsed)) {
    return { error: "ABI must be a JSON array" };
  }

  const entry = findAbiFunction(parsed, functionName);

  if (!entry) {
    return { error: `Function '${functionName}' not found in ABI` };
  }

  return { entry };
}

async function resolveAbiForRequest(
  body: Record<string, unknown>
): Promise<{ abi: string } | { error: string }> {
  if (typeof body.abi === "string" && body.abi.trim() !== "") {
    return { abi: body.abi };
  }

  try {
    const resolved = await resolveAbi({
      contractAddress: body.contractAddress as string,
      network: body.network as string,
    });
    return { abi: resolved.abi };
  } catch (err: unknown) {
    return {
      error: `ABI is required. Could not auto-fetch ABI: ${getErrorMessage(err)}`,
    };
  }
}

async function handleReadCall(
  body: Record<string, unknown>,
  resolvedAbi: string,
  organizationId: string
): Promise<NextResponse> {
  const result = await readContractCore({
    contractAddress: body.contractAddress as string,
    network: body.network as string,
    abi: resolvedAbi,
    abiFunction: body.functionName as string,
    functionArgs: body.functionArgs as string | undefined,
    _context: { organizationId },
  });

  if (result.success) {
    return NextResponse.json(
      { result: result.result },
      { status: HttpStatus.OK }
    );
  }

  return NextResponse.json(
    { error: result.error },
    { status: HttpStatus.BAD_REQUEST }
  );
}

async function handleSimulateCall(
  body: Record<string, unknown>,
  resolvedAbi: string,
  organizationId: string
): Promise<NextResponse> {
  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return walletError;
  }

  const result = await simulateContractCall({
    organizationId,
    network: body.network as string,
    contractAddress: body.contractAddress as string,
    abi: resolvedAbi,
    functionName: body.functionName as string,
    functionArgs: body.functionArgs as string | undefined,
    value: body.value as string | undefined,
  });

  return NextResponse.json(result, {
    status: result.wouldRevert ? HttpStatus.BAD_REQUEST : HttpStatus.OK,
  });
}

async function handleWriteCall(
  body: Record<string, unknown>,
  resolvedAbi: string,
  organizationId: string,
  apiKeyId: string
): Promise<NextResponse> {
  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return walletError;
  }

  const redactedInput = redactInput(body);
  const reserve = await checkAndReserveExecution({
    organizationId,
    apiKeyId,
    type: "contract-call",
    network: body.network as string,
    input: redactedInput,
  });
  if (!reserve.allowed) {
    return NextResponse.json(
      { error: reserve.reason },
      { status: HttpStatus.FORBIDDEN }
    );
  }
  const { executionId } = reserve;

  await markRunning(executionId);

  const result = await writeContractCore({
    contractAddress: body.contractAddress as string,
    network: body.network as string,
    abi: resolvedAbi,
    abiFunction: body.functionName as string,
    functionArgs: body.functionArgs as string | undefined,
    ethValue: body.value as string | undefined,
    gasLimitMultiplier: body.gasLimitMultiplier as string | undefined,
    priorityFeeGwei: body.priorityFeeGwei as string | undefined,
    _context: { organizationId },
  });

  if (result.success) {
    await completeExecution(executionId, {
      transactionHash: result.transactionHash,
      transactionLink: result.transactionLink,
      gasUsedWei: result.gasUsed,
      gasPriceWei: result.effectiveGasPrice,
      output: result as unknown as Record<string, unknown>,
    });
  } else {
    await failExecution(executionId, result.error);
  }

  return NextResponse.json(
    { executionId, status: result.success ? "completed" : "failed" },
    { status: HttpStatus.ACCEPTED }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if (!apiKeyCtx) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  // Enter ALS error context so plugin step errors carry org labels
  await enterApiExecuteErrorContext(apiKeyCtx.organizationId);

  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rateLimit
    );
  }

  const executionGuard = await enforceExecutionLimit(apiKeyCtx.organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const validation = validateContractCallInput(body);
  if (!validation.valid) {
    return NextResponse.json(validation.error, {
      status: HttpStatus.BAD_REQUEST,
    });
  }

  // KEEP-490: collapse `chainId` (canonical) and `network` (deprecated alias)
  // onto a single field so the downstream read sites do not have to know about
  // both. The core helpers normalize chain names/IDs internally.
  if (body.chainId !== undefined && body.network === undefined) {
    body.network = String(body.chainId);
  }

  const abiResult = await resolveAbiForRequest(body);
  if ("error" in abiResult) {
    return NextResponse.json(
      { error: abiResult.error, field: "abi" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const resolvedAbi = abiResult.abi;

  const fnResult = findFunctionInAbi(resolvedAbi, body.functionName as string);
  if ("error" in fnResult) {
    return NextResponse.json(
      { error: fnResult.error, field: "functionName" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const isReadOnly =
    fnResult.entry.stateMutability === "view" ||
    fnResult.entry.stateMutability === "pure";

  if (isReadOnly) {
    return applyRateLimitHeaders(
      await handleReadCall(body, resolvedAbi, apiKeyCtx.organizationId),
      rateLimit
    );
  }

  // Dry-run path: validate inputs, simulate via provider.call + estimateGas,
  // never broadcast, never reserve a directExecutions row. Triggered by
  // strict boolean `simulate: true` on the body.
  const simulateFlag = parseSimulateFlag(body);
  if (!simulateFlag.ok) {
    return NextResponse.json(
      { error: simulateFlag.error, field: "simulate" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }
  if (simulateFlag.simulate) {
    return applyRateLimitHeaders(
      await handleSimulateCall(body, resolvedAbi, apiKeyCtx.organizationId),
      rateLimit
    );
  }

  return applyRateLimitHeaders(
    await handleWriteCall(
      body,
      resolvedAbi,
      apiKeyCtx.organizationId,
      apiKeyCtx.apiKeyId
    ),
    rateLimit
  );
}
