import "server-only";

import { NextResponse } from "next/server";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { db } from "@/lib/db";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import {
  executeGasTopUp,
  type GasTopUpRefusalCode,
  type GasTopUpResult,
  prepareGasTopUp,
} from "@/lib/execute/gas-top-up";
import {
  isOrgHalted,
  ORG_HALTED_REASON,
} from "@/lib/execute/org-circuit-breaker";
import { HttpStatus, type HttpStatusCode } from "@/lib/http-status";
import {
  beginIdempotentFromRequest,
  dispositionForExecutionOutcome,
  type IdempotencyDisposition,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { logSecurityEvent } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { validateApiKey } from "../_lib/auth";
import { enforceDirectExecutionConcurrency } from "../_lib/concurrency-limit";
import {
  type CompleteExecutionOutcome,
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { refuseSimulateBody, rejectSimulateQuery } from "../_lib/simulate-flag";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import type { ExecuteResponse } from "../_lib/types";
import { validateGasTopUpInput } from "../_lib/validate";
import { requireWallet } from "../_lib/wallet-check";

const ENDPOINT = "/api/execute/gas-top-up";

const REFUSAL_STATUS: Readonly<Record<GasTopUpRefusalCode, HttpStatusCode>> = {
  UNSUPPORTED_CHAIN: HttpStatus.BAD_REQUEST,
  INVALID_AMOUNT: HttpStatus.BAD_REQUEST,
  USDC_NOT_CONFIGURED: HttpStatus.UNPROCESSABLE_ENTITY,
  STABLECOIN_CAP_EXCEEDED: HttpStatus.FORBIDDEN,
  SPONSORSHIP_UNAVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,
};

type GasTopUpResponse = ExecuteResponse &
  Pick<
    GasTopUpResult,
    | "steps"
    | "usdcSpent"
    | "ethReceived"
    | "wethReceived"
    | "quotedWethOut"
    | "amountOutMinimum"
    | "sponsored"
  > & { chainId: number; wallet: string };

/**
 * Certainty decides the key, as everywhere else -- with one addition. Once the
 * swap has confirmed, the USDC is gone whatever the unwrap did, so the key is
 * held even where the generic rule would release a conclusive failure: a
 * retry under the same key must replay this result, not spend again.
 */
function gasTopUpDisposition(
  status: CompleteExecutionOutcome["status"],
  result: GasTopUpResult
): IdempotencyDisposition {
  if (status === "completed") {
    return "success";
  }
  if (result.swapLanded) {
    return "failed";
  }
  return dispositionForExecutionOutcome(status, {
    transactionHash: result.failure?.transactionHash,
    sponsored: true,
    broadcastAttempted: result.failure?.broadcastAttempted,
  });
}

async function settle(
  executionId: string,
  result: GasTopUpResult
): Promise<CompleteExecutionOutcome> {
  const output = result as unknown as Record<string, unknown>;
  if (result.success) {
    // KEEP-966: the final (unwrap) hash is re-verified on chain; its verdict,
    // not result.success, is what the response and idempotency record carry.
    return await completeExecution(executionId, {
      transactionHash: result.finalTransactionHash,
      transactionLink: result.finalTransactionLink,
      chainId: result.chainId,
      gasUsedWei: result.gasUsedWei,
      output,
    });
  }
  const error = result.error ?? "Gas top-up failed";
  // The failing step's own hash (if any) goes to failExecution, not the last
  // hash that landed: a confirmed approve would re-verify as successful and
  // leave a stopped sequence reading as in-flight.
  const settled = await failExecution(executionId, error, {
    transactionHash: result.failure?.transactionHash,
    chainId: result.chainId,
    sponsored: true,
    broadcastAttempted: result.failure?.broadcastAttempted,
    errorClass: result.failure?.errorClass,
    output,
  });
  return { status: settled.status, error };
}

function buildResponse(
  executionId: string,
  outcome: CompleteExecutionOutcome,
  result: GasTopUpResult
): GasTopUpResponse {
  const transactionHash =
    result.finalTransactionHash ?? result.failure?.transactionHash;
  return {
    executionId,
    status: outcome.status,
    chainId: result.chainId,
    wallet: result.wallet,
    ...(transactionHash ? { transactionHash } : {}),
    ...(result.finalTransactionLink
      ? { transactionLink: result.finalTransactionLink }
      : {}),
    steps: result.steps,
    ...(result.usdcSpent === undefined ? {} : { usdcSpent: result.usdcSpent }),
    ...(result.ethReceived ? { ethReceived: result.ethReceived } : {}),
    ...(result.wethReceived ? { wethReceived: result.wethReceived } : {}),
    ...(result.quotedWethOut ? { quotedWethOut: result.quotedWethOut } : {}),
    ...(result.amountOutMinimum
      ? { amountOutMinimum: result.amountOutMinimum }
      : {}),
    sponsored: true,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(result.failure?.errorClass
      ? { errorClass: result.failure.errorClass }
      : {}),
  };
}

/**
 * Convert USDC on the org's Turnkey EOA into native ETH on the same wallet
 * (#2435): approve exactly amountUsdc, swap on Uniswap V3 with a floor derived
 * from a same-request QuoterV2 quote, unwrap the WETH. Every transaction is
 * gas-sponsored; if sponsorship is unavailable the request is refused.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if ("error" in apiKeyCtx) {
    return NextResponse.json(
      { error: apiKeyCtx.error },
      { status: apiKeyCtx.status }
    );
  }

  const simulateQuery = rejectSimulateQuery(request);
  if (simulateQuery) {
    return simulateQuery;
  }

  const scopeError = requireScope(apiKeyCtx.scope, SCOPE_MCP_WRITE, {
    organizationId: apiKeyCtx.organizationId,
    credentialId: apiKeyCtx.apiKeyId,
    credentialType: apiKeyCtx.credentialType,
    endpoint: ENDPOINT,
  });
  if (scopeError) {
    return scopeError;
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

  // No dry-run mode; refused before anything is reserved.
  const simulateBody = refuseSimulateBody(body);
  if (simulateBody) {
    return simulateBody;
  }

  const organizationId = apiKeyCtx.organizationId;
  await enterApiExecuteErrorContext(organizationId);

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

  const executionGuard = await enforceExecutionLimit(organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  const validation = validateGasTopUpInput(body);
  if (!validation.valid) {
    return applyRateLimitHeaders(
      NextResponse.json(validation.error, { status: HttpStatus.BAD_REQUEST }),
      rateLimit
    );
  }
  const chainId = Number(body.chainId);
  const amountUsdc = body.amountUsdc as string;

  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return applyRateLimitHeaders(walletError, rateLimit);
  }

  // checkAndReserveExecution only consults the breaker when native value is
  // reserved, and this route reserves 0 (the USDC leaves as a token, the ETH
  // arrives rather than leaves), so the breaker is checked here explicitly.
  if (await isOrgHalted(db, organizationId)) {
    logSecurityEvent("org_circuit_breaker_blocked", {
      organizationId,
      surface: "gas-top-up",
      chainFamily: "evm",
    });
    return applyRateLimitHeaders(
      NextResponse.json(
        { error: ORG_HALTED_REASON },
        { status: HttpStatus.FORBIDDEN }
      ),
      rateLimit
    );
  }

  const preparation = await prepareGasTopUp({
    organizationId,
    chainId,
    amountUsdc,
  });
  if (!preparation.ok) {
    return applyRateLimitHeaders(
      NextResponse.json(
        {
          error: preparation.error,
          code: preparation.code,
          ...(preparation.field ? { field: preparation.field } : {}),
        },
        { status: REFUSAL_STATUS[preparation.code] }
      ),
      rateLimit
    );
  }

  const concurrency = await enforceDirectExecutionConcurrency(organizationId);
  if (concurrency) {
    return concurrency;
  }

  const idem = await beginIdempotentFromRequest({
    request,
    organizationId,
    scope: "execute:gas-top-up",
    requestBody: body,
  });
  if (idem) {
    const early = idempotencyEarlyResponse(idem);
    if (early) {
      return applyRateLimitHeaders(
        NextResponse.json(early.body, { status: early.status }),
        rateLimit
      );
    }
  }

  const reserve = await checkAndReserveExecution({
    organizationId,
    apiKeyId: apiKeyCtx.apiKeyId,
    type: "gas-top-up",
    network: String(chainId),
    input: redactInput(body),
    reserved: { kind: "evm", valueWei: "0" },
    paygOverflow: executionGuard.limitResult?.paygOverflow === true,
  });
  if (!reserve.allowed) {
    return applyRateLimitHeaders(
      await recordIdempotentResponse(
        idem,
        NextResponse.json(
          { error: reserve.reason },
          { status: HttpStatus.FORBIDDEN }
        ),
        "release"
      ),
      rateLimit
    );
  }
  const { executionId } = reserve;

  await markRunning(executionId);

  const result = await withIdempotencyHeartbeat(idem, () =>
    executeGasTopUp({ plan: preparation.plan, executionId })
  );

  const outcome = await settle(executionId, result);

  return applyRateLimitHeaders(
    await recordIdempotentResponse(
      idem,
      NextResponse.json(buildResponse(executionId, outcome, result), {
        status: HttpStatus.ACCEPTED,
      }),
      gasTopUpDisposition(outcome.status, result)
    ),
    rateLimit
  );
}
