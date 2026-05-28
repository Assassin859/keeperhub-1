import "server-only";

import { NextResponse } from "next/server";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import {
  simulateNativeTransfer,
  simulateTokenTransfer,
} from "@/lib/execute/simulate";
import { transferFundsCore } from "@/plugins/web3/steps/transfer-funds-core";
import { transferTokenCore } from "@/plugins/web3/steps/transfer-token-core";
import { validateApiKey } from "../_lib/auth";
import {
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import { validateTokenFields, validateTransferInput } from "../_lib/validate";
import { requireWallet } from "../_lib/wallet-check";

function extractTokenAddress(
  body: Record<string, unknown>
): string | undefined {
  if (typeof body.tokenAddress === "string" && body.tokenAddress !== "") {
    return body.tokenAddress;
  }
  const tokenConfig = body.tokenConfig;
  if (typeof tokenConfig === "string" && tokenConfig !== "") {
    try {
      const parsed = JSON.parse(tokenConfig) as {
        customToken?: { address?: string };
      };
      return parsed.customToken?.address;
    } catch {
      return;
    }
  }
  if (tokenConfig && typeof tokenConfig === "object") {
    const custom = (tokenConfig as { customToken?: { address?: string } })
      .customToken;
    return custom?.address;
  }
  return;
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Auth
  const apiKeyCtx = await validateApiKey(request);
  if (!apiKeyCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Enter ALS error context so plugin step errors carry org labels
  await enterApiExecuteErrorContext(apiKeyCtx.organizationId);

  // 2. Rate limit
  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  // 2.5 Plan execution-limit guard
  const executionGuard = await enforceExecutionLimit(apiKeyCtx.organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  // 3. Parse body
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 4. Validate input
  const validation = validateTransferInput(body);
  if (!validation.valid) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  const tokenValidation = validateTokenFields(body);
  if (!tokenValidation.valid) {
    return NextResponse.json(tokenValidation.error, { status: 400 });
  }

  // KEEP-490: accept `chainId` as canonical, `network` as deprecated alias.
  // The core helper normalizes the value internally (chainId number / string,
  // or a known chain name) so we just pick whichever field is present.
  const network = String(
    (body as Record<string, unknown>).chainId ?? body.network ?? ""
  );
  const { recipientAddress, amount } = body as {
    recipientAddress: string;
    amount: string;
  };

  const isTokenTransfer = "tokenAddress" in body || "tokenConfig" in body;

  // 5. Wallet check
  const walletError = await requireWallet(apiKeyCtx.organizationId);
  if (walletError) {
    return walletError;
  }

  // 5.5 Dry-run path: validate inputs, simulate via estimateGas only,
  // never broadcast, never reserve. Triggered by `?simulate=true` or
  // `{"simulate": true}` body field.
  const url = new URL(request.url);
  const shouldSimulate =
    body.simulate === true || url.searchParams.get("simulate") === "true";
  if (shouldSimulate) {
    if (isTokenTransfer) {
      const decimals =
        typeof body.decimals === "number"
          ? body.decimals
          : Number(body.decimals ?? 18);
      const tokenAddress =
        (body.tokenAddress as string | undefined) ?? extractTokenAddress(body);
      if (!tokenAddress) {
        return NextResponse.json(
          {
            error:
              "Simulating a token transfer requires `tokenAddress` (or a `tokenConfig` with a custom token address)",
          },
          { status: 400 }
        );
      }
      const result = await simulateTokenTransfer({
        organizationId: apiKeyCtx.organizationId,
        network,
        tokenAddress,
        recipientAddress,
        amount,
        decimals,
      });
      return NextResponse.json(result, {
        status: result.wouldRevert ? 400 : 200,
      });
    }
    const nativeResult = await simulateNativeTransfer({
      organizationId: apiKeyCtx.organizationId,
      network,
      recipientAddress,
      amount,
    });
    return NextResponse.json(nativeResult, {
      status: nativeResult.wouldRevert ? 400 : 200,
    });
  }

  // 6. Spending cap + create execution atomically
  const redactedInput = redactInput(body);
  const reserve = await checkAndReserveExecution({
    organizationId: apiKeyCtx.organizationId,
    apiKeyId: apiKeyCtx.apiKeyId,
    type: "transfer",
    network,
    input: redactedInput,
  });
  if (!reserve.allowed) {
    return NextResponse.json({ error: reserve.reason }, { status: 403 });
  }
  const { executionId } = reserve;

  // 7. Mark running
  await markRunning(executionId);

  // 8. Execute
  const context = { organizationId: apiKeyCtx.organizationId };

  const result = isTokenTransfer
    ? await transferTokenCore({
        network,
        tokenConfig: (body.tokenConfig ?? "") as
          | string
          | Record<string, unknown>,
        tokenAddress: body.tokenAddress as string | undefined,
        recipientAddress,
        amount,
        _context: context,
      })
    : await transferFundsCore({
        network,
        recipientAddress,
        amount,
        _context: context,
      });

  // 9. Handle result
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

  // 10. Return
  return NextResponse.json(
    { executionId, status: result.success ? "completed" : "failed" },
    { status: 202 }
  );
}
