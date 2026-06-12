import "server-only";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { db } from "@/lib/db";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { integrations } from "@/lib/db/schema";
import {
  beginIdempotentFromRequest,
  PROCESSING_TTL_MS as IDEMPOTENCY_PROCESSING_TTL_MS,
  type IdempotencyOutcome,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { getErrorMessage } from "@/lib/utils";
import type { ResolvedAction } from "../_lib/action-resolver";
import { resolveAction } from "../_lib/action-resolver";
import type { ApiKeyContext } from "../_lib/auth";
import { validateApiKey } from "../_lib/auth";
import {
  completeExecution,
  createExecution,
  failExecution,
  markRunning,
  redactInput,
  setRetryCount,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import {
  DEFAULT_TIMEOUT_MS as DEFAULT_RETRY_TIMEOUT_MS,
  executeWithRetry,
  genericRetryOptions,
  type TransactionResult,
  transactionRetryOptions,
} from "../_lib/retry";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import type { NodeExecuteRequest, RetryConfig } from "../_lib/types";
import { requireWallet } from "../_lib/wallet-check";

// The worst-case retry budget (timeoutMs x attempts) must not exceed the
// idempotency processing-lock TTL, so a single request cannot outlive its own
// reservation and have a reclaimer take the slot mid-flight.
const MAX_RETRY_BUDGET_MS = IDEMPOTENCY_PROCESSING_TTL_MS;

function validateRetryConfig(
  raw: unknown
): { valid: true; data: RetryConfig } | { valid: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "retry must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;

  if (
    r.maxRetries !== undefined &&
    (typeof r.maxRetries !== "number" || r.maxRetries < 0 || r.maxRetries > 10)
  ) {
    return {
      valid: false,
      error: "retry.maxRetries must be a number between 0 and 10",
    };
  }
  if (
    r.timeoutMs !== undefined &&
    (typeof r.timeoutMs !== "number" ||
      r.timeoutMs < 1000 ||
      r.timeoutMs > 600_000)
  ) {
    return {
      valid: false,
      error: "retry.timeoutMs must be a number between 1000 and 600000",
    };
  }
  if (
    r.gasBumpPercent !== undefined &&
    (typeof r.gasBumpPercent !== "number" ||
      r.gasBumpPercent < 0 ||
      r.gasBumpPercent > 100)
  ) {
    return {
      valid: false,
      error: "retry.gasBumpPercent must be a number between 0 and 100",
    };
  }

  const attempts = ((r.maxRetries as number | undefined) ?? 0) + 1;
  const perAttempt =
    (r.timeoutMs as number | undefined) ?? DEFAULT_RETRY_TIMEOUT_MS;
  if (attempts * perAttempt > MAX_RETRY_BUDGET_MS) {
    return {
      valid: false,
      error: `retry budget (timeoutMs x (maxRetries + 1)) must not exceed ${MAX_RETRY_BUDGET_MS}ms`,
    };
  }

  return {
    valid: true,
    data: {
      maxRetries: r.maxRetries as number | undefined,
      timeoutMs: r.timeoutMs as number | undefined,
      gasBumpPercent: r.gasBumpPercent as number | undefined,
    },
  };
}

function validateRequest(
  body: unknown
): { valid: true; data: NodeExecuteRequest } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const req = body as Record<string, unknown>;

  if (typeof req.actionType !== "string" || req.actionType.trim() === "") {
    return { valid: false, error: "actionType is required" };
  }

  if (
    !req.config ||
    typeof req.config !== "object" ||
    Array.isArray(req.config)
  ) {
    return { valid: false, error: "config must be a JSON object" };
  }

  if (
    req.integrationId !== undefined &&
    typeof req.integrationId !== "string"
  ) {
    return { valid: false, error: "integrationId must be a string" };
  }

  if (req.network !== undefined && typeof req.network !== "string") {
    return { valid: false, error: "network must be a string" };
  }

  let retry: RetryConfig | undefined;
  if (req.retry !== undefined) {
    const retryResult = validateRetryConfig(req.retry);
    if (!retryResult.valid) {
      return retryResult;
    }
    retry = retryResult.data;
  }

  return {
    valid: true,
    data: {
      actionType: req.actionType as string,
      config: req.config as Record<string, unknown>,
      integrationId: req.integrationId as string | undefined,
      network: req.network as string | undefined,
      retry,
    },
  };
}

async function verifyIntegrationOwnership(
  integrationId: string,
  organizationId: string
): Promise<boolean> {
  const result = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId)
      )
    )
    .limit(1);

  return result.length > 0;
}

function isTransactionResult(output: unknown): output is {
  transactionHash: string;
  gasUsed: string;
  gasUsedUnits?: string;
  effectiveGasPrice?: string;
} {
  if (!output || typeof output !== "object") {
    return false;
  }
  const obj = output as Record<string, unknown>;
  return (
    typeof obj.transactionHash === "string" && typeof obj.gasUsed === "string"
  );
}

// biome-ignore lint/suspicious/noExplicitAny: Step functions have varying signatures
type StepFn = (input: any) => Promise<unknown>;

type InvokeResult =
  | { ok: true; result: unknown; retryCount: number }
  | { ok: false; error: string; retryCount: number };

function unwrapRetryResult<T>(
  retryResult: Awaited<ReturnType<typeof executeWithRetry<T>>>
): InvokeResult {
  if (
    retryResult.outcome === "timeout" ||
    retryResult.outcome === "exhausted"
  ) {
    return {
      ok: false,
      error: retryResult.error,
      retryCount: retryResult.retryCount,
    };
  }
  return {
    ok: true,
    result: retryResult.result,
    retryCount: retryResult.retryCount,
  };
}

async function invokeStep(
  stepFn: StepFn,
  stepInput: Record<string, unknown>,
  retry: RetryConfig | undefined,
  isWeb3: boolean
): Promise<InvokeResult> {
  if (retry) {
    if (isWeb3) {
      const retryResult = await executeWithRetry<TransactionResult>(
        async () => (await stepFn(stepInput)) as TransactionResult,
        retry,
        transactionRetryOptions
      );
      return unwrapRetryResult(retryResult);
    }
    const retryResult = await executeWithRetry<unknown>(
      async () => stepFn(stepInput),
      retry,
      genericRetryOptions
    );
    return unwrapRetryResult(retryResult);
  }
  const result = await stepFn(stepInput);
  return { ok: true, result, retryCount: 0 };
}

async function handleResult(
  executionId: string,
  result: unknown,
  retryCount: number,
  idem: IdempotencyOutcome | null
): Promise<NextResponse> {
  const output = result as Record<string, unknown> | undefined;
  const success =
    output && typeof output === "object" && "success" in output
      ? (output.success as boolean)
      : true;

  if (!success) {
    const errorMsg =
      output && "error" in output ? String(output.error) : "Execution failed";
    await failExecution(executionId, errorMsg);
    // The step ran (possibly broadcasting): finalize as failed so a retry
    // replays the failure instead of re-executing.
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        {
          executionId,
          status: "failed",
          error: errorMsg,
          ...(retryCount > 0 ? { retryCount } : {}),
        },
        { status: 422 }
      ),
      "failed"
    );
  }

  const completeParams: Parameters<typeof completeExecution>[1] = {
    output: output ?? {},
  };

  if (isTransactionResult(output)) {
    completeParams.transactionHash = output.transactionHash;
    completeParams.gasUsedWei = output.gasUsed;
    completeParams.gasPriceWei = output.effectiveGasPrice;
  }

  await completeExecution(executionId, completeParams);

  return recordIdempotentResponse(
    idem,
    NextResponse.json(
      {
        executionId,
        status: "completed",
        result: output,
        ...(retryCount > 0 ? { retryCount } : {}),
      },
      { status: isTransactionResult(output) ? 202 : 200 }
    ),
    "success"
  );
}

async function executeNode(
  data: NodeExecuteRequest,
  resolved: ResolvedAction,
  apiKeyCtx: ApiKeyContext,
  idem: IdempotencyOutcome | null,
  preCreatedExecutionId?: string,
  resolvedRefs?: { network?: string; integrationId?: string }
): Promise<NextResponse> {
  const { config, retry } = data;
  const network = resolvedRefs?.network;
  const integrationId = resolvedRefs?.integrationId;

  // Drop caller-supplied gating keys so the step only sees the values the
  // route resolved and gated on. web3Connection is intentionally preserved;
  // it stays org-ownership-verified downstream in lib/safe/signer-resolver.ts.
  const {
    network: _ignoredNetwork,
    integrationId: _ignoredIntegrationId,
    _context: _ignoredContext,
    ...safeConfig
  } = config;

  let executionId: string;
  if (preCreatedExecutionId) {
    executionId = preCreatedExecutionId;
  } else {
    const redactedInput = redactInput({
      actionType: data.actionType,
      ...safeConfig,
    });
    const created = await createExecution({
      organizationId: apiKeyCtx.organizationId,
      apiKeyId: apiKeyCtx.apiKeyId,
      type: resolved.actionType,
      network,
      input: redactedInput,
    });
    executionId = created.executionId;
  }

  await markRunning(executionId);

  const stepInput = {
    ...safeConfig,
    ...(integrationId ? { integrationId } : {}),
    ...(network ? { network } : {}),
    _context: {
      executionId,
      nodeId: executionId,
      nodeName: resolved.label,
      nodeType: "action",
      organizationId: apiKeyCtx.organizationId,
    },
  };

  try {
    const module = await resolved.importer.importer();
    const stepFn = module[resolved.importer.stepFunction] as StepFn | undefined;

    if (typeof stepFn !== "function") {
      await failExecution(
        executionId,
        `Step function not found: ${resolved.importer.stepFunction}`
      );
      // Never reached the step: release for a clean retry.
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          { error: "Internal error: step function not found" },
          { status: 500 }
        ),
        "release"
      );
    }

    const invokeResult = await withIdempotencyHeartbeat(idem, () =>
      invokeStep(stepFn, stepInput, retry, Boolean(network))
    );

    if (invokeResult.retryCount > 0) {
      await setRetryCount(executionId, invokeResult.retryCount);
    }

    if (!invokeResult.ok) {
      await failExecution(executionId, invokeResult.error);
      // The step ran (possibly broadcasting): finalize as failed.
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          {
            executionId,
            status: "failed",
            error: invokeResult.error,
            ...(invokeResult.retryCount > 0
              ? { retryCount: invokeResult.retryCount }
              : {}),
          },
          { status: 422 }
        ),
        "failed"
      );
    }

    return await handleResult(
      executionId,
      invokeResult.result,
      invokeResult.retryCount,
      idem
    );
  } catch (err: unknown) {
    const errorMsg = getErrorMessage(err);
    await failExecution(executionId, errorMsg);
    // A thrown error may have left a tx mid-broadcast: finalize as failed.
    return recordIdempotentResponse(
      idem,
      NextResponse.json(
        { executionId, status: "failed", error: errorMsg },
        { status: 500 }
      ),
      "failed"
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if (!apiKeyCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const scopeError = requireScope(apiKeyCtx.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
  }

  // Enter ALS error context so plugin step errors carry org labels
  await enterApiExecuteErrorContext(apiKeyCtx.organizationId);

  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  const executionGuard = await enforceExecutionLimit(apiKeyCtx.organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateRequest(body);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { actionType, config, integrationId, network } = validation.data;

  // Gating keys can ride inside caller config; merge them in so ownership,
  // wallet, and spending-cap checks cannot be bypassed by nesting them there.
  const configNetwork =
    typeof config.network === "string" && config.network.trim() !== ""
      ? config.network
      : undefined;
  const configIntegrationId =
    typeof config.integrationId === "string" &&
    config.integrationId.trim() !== ""
      ? config.integrationId
      : undefined;
  const effectiveNetwork = network ?? configNetwork;
  const effectiveIntegrationId = integrationId ?? configIntegrationId;

  const resolved = resolveAction(actionType);
  if (!resolved) {
    return NextResponse.json(
      { error: `Unknown action type: ${actionType}` },
      { status: 400 }
    );
  }

  if (effectiveIntegrationId) {
    const owned = await verifyIntegrationOwnership(
      effectiveIntegrationId,
      apiKeyCtx.organizationId
    );
    if (!owned) {
      return NextResponse.json(
        {
          error:
            "Integration not found or does not belong to this organization",
        },
        { status: 403 }
      );
    }
  }

  const resolvedRefs = {
    network: effectiveNetwork,
    integrationId: effectiveIntegrationId,
  };

  // Idempotency: reserve the key before any state-changing node execution.
  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: apiKeyCtx.organizationId,
    scope: `execute:node:${actionType}`,
    requestBody: body,
  });
  if (idem) {
    const early = idempotencyEarlyResponse(idem);
    if (early) {
      return NextResponse.json(early.body, { status: early.status });
    }
  }

  if (effectiveNetwork) {
    const walletError = await requireWallet(apiKeyCtx.organizationId);
    if (walletError) {
      // Pre-broadcast gating failure: release for a clean retry.
      return recordIdempotentResponse(idem, walletError, "release");
    }

    const redactedInput = redactInput({
      actionType: validation.data.actionType,
      ...validation.data.config,
    });
    const reserve = await checkAndReserveExecution({
      organizationId: apiKeyCtx.organizationId,
      apiKeyId: apiKeyCtx.apiKeyId,
      type: resolved.actionType,
      network: effectiveNetwork,
      input: redactedInput,
    });
    if (!reserve.allowed) {
      return recordIdempotentResponse(
        idem,
        NextResponse.json({ error: reserve.reason }, { status: 403 }),
        "release"
      );
    }

    // executeNode settles the idempotency record (finalize/failed) per branch.
    return executeNode(
      validation.data,
      resolved,
      apiKeyCtx,
      idem,
      reserve.executionId,
      resolvedRefs
    );
  }

  return executeNode(
    validation.data,
    resolved,
    apiKeyCtx,
    idem,
    undefined,
    resolvedRefs
  );
}
