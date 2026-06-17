import { HttpStatus } from "@/lib/http-status";
import "server-only";
import "@/protocols";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi/cache";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import {
  beginIdempotentFromRequest,
  type IdempotencyDisposition,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
  withIdempotencyHeartbeat,
} from "@/lib/idempotency";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { getProtocol } from "@/lib/protocol-registry";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { PLUGIN_STEP_IMPORTERS } from "@/lib/step-registry";
import { resolveProtocolMeta } from "@/plugins/protocol/steps/resolve-protocol-meta";
import {
  type ReadContractCoreInput,
  readContractCore,
} from "@/plugins/web3/steps/read-contract-core";
import {
  type WriteContractCoreInput,
  writeContractCore,
} from "@/plugins/web3/steps/write-contract-core";
import { validateApiKey } from "../_lib/auth";
import {
  completeExecution,
  failExecution,
  markRunning,
  redactInput,
  withRejectedSignerOverride,
} from "../_lib/execution-service";
import { checkRateLimit } from "../_lib/rate-limit";
import { checkAndReserveExecution } from "../_lib/spending-cap";
import { requireWallet } from "../_lib/wallet-check";

function buildFunctionArgs(
  input: Record<string, unknown>,
  protocolSlug: string,
  contractKey: string,
  functionName: string
): string | undefined {
  const protocol = getProtocol(protocolSlug);
  if (!protocol) {
    return undefined;
  }

  const protocolAction = protocol.actions.find(
    (a) => a.function === functionName && a.contract === contractKey
  );

  if (!protocolAction || protocolAction.inputs.length === 0) {
    return undefined;
  }

  const args = protocolAction.inputs.map((inp) => {
    const value = input[inp.name];
    return value === undefined ? "" : String(value);
  });

  return JSON.stringify(args);
}

async function executeProtocolAction(
  actionType: string,
  body: Record<string, unknown>,
  organizationId: string,
  apiKeyId: string
): Promise<NextResponse> {
  const meta = resolveProtocolMeta({ _actionType: actionType });
  if (!meta) {
    return NextResponse.json(
      {
        success: false,
        error: `Could not resolve protocol metadata for: ${actionType}`,
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const protocol = getProtocol(meta.protocolSlug);
  if (!protocol) {
    return NextResponse.json(
      { success: false, error: `Unknown protocol: ${meta.protocolSlug}` },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const contract = protocol.contracts[meta.contractKey];
  if (!contract) {
    return NextResponse.json(
      {
        success: false,
        error: `Unknown contract key "${meta.contractKey}" in protocol "${meta.protocolSlug}"`,
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  // KEEP-490: accept `chainId` as the canonical input, with `network` as a
  // deprecated alias. Either field may carry the numeric chain ID (1, 11155111)
  // or a known chain name/slug ("ethereum", "sepolia", "base"). Downstream
  // helpers (contract.addresses, resolveAbi, the chain adapter) are keyed by
  // numeric chainId, so normalize here once.
  const rawNetwork = String(body.chainId ?? body.network ?? "");
  if (!rawNetwork) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Missing required field: chainId (or network, which is a deprecated alias)",
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  let resolvedChainId: number;
  try {
    resolvedChainId = getChainIdFromNetwork(rawNetwork);
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }
  const network = String(resolvedChainId);

  const contractAddress = contract.userSpecifiedAddress
    ? String(body.contractAddress ?? "")
    : contract.addresses[network];

  if (!contractAddress) {
    return NextResponse.json(
      {
        success: false,
        error: contract.userSpecifiedAddress
          ? `Missing contract address for "${meta.contractKey}"`
          : `Protocol "${meta.protocolSlug}" contract "${meta.contractKey}" is not deployed on chain ${network} (input: "${rawNetwork}")`,
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  let resolvedAbi: string;
  try {
    const abiResult = await resolveAbi({
      contractAddress,
      network,
      abi: contract.abi,
    });
    resolvedAbi = abiResult.abi;
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: `Failed to resolve ABI: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const functionArgs = buildFunctionArgs(
    body,
    meta.protocolSlug,
    meta.contractKey,
    meta.functionName
  );

  if (meta.actionType === "read") {
    const coreInput: ReadContractCoreInput = {
      contractAddress,
      network,
      abi: resolvedAbi,
      abiFunction: meta.functionName,
      functionArgs,
      _context: { organizationId },
    };
    const result = await readContractCore(coreInput);
    return NextResponse.json(result);
  }

  // KEEP-793 / A-07: protocol write actions sign and broadcast a real tx from
  // the org wallet, so they must clear the same gates as every other direct
  // write path (transfer, contract-call, check-and-execute): plan execution
  // limit, wallet presence, daily spend cap, and a recorded directExecutions
  // audit row. Reads above stay ungated.
  const executionGuard = await enforceExecutionLimit(organizationId);
  if (executionGuard.blocked) {
    return executionGuard.response;
  }

  const walletError = await requireWallet(organizationId);
  if (walletError) {
    return walletError;
  }

  const reserve = await checkAndReserveExecution({
    organizationId,
    apiKeyId,
    type: "protocol-action",
    network,
    input: redactInput(withRejectedSignerOverride(body, body)),
  });
  if (!reserve.allowed) {
    return NextResponse.json(
      { success: false, error: reserve.reason },
      { status: HttpStatus.FORBIDDEN }
    );
  }
  const { executionId } = reserve;
  await markRunning(executionId);

  const ethValue = body.ethValue ? String(body.ethValue) : undefined;
  const coreInput: WriteContractCoreInput = {
    contractAddress,
    network,
    abi: resolvedAbi,
    abiFunction: meta.functionName,
    functionArgs,
    ethValue,
    _context: { organizationId },
  };
  const result = await writeContractCore(coreInput);

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

  return NextResponse.json(result);
}

// Disposition for a protocol-action response. Reads and successful writes are a
// replayable success. A write returning success:false (revert) reached the
// broadcast path, so it is finalized as failed (never released) to keep a retry
// from re-broadcasting.
function protocolActionDisposition(
  response: NextResponse
): Promise<IdempotencyDisposition> {
  return response
    .clone()
    .json()
    .then((b: unknown): IdempotencyDisposition => {
      const record = (b ?? {}) as Record<string, unknown>;
      return record.success === false ? "failed" : "success";
    })
    .catch(
      (): IdempotencyDisposition =>
        response.status >= 200 && response.status < 300 ? "success" : "failed"
    );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string[] }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const actionType = slug.join("/");

  if (slug.length < 2) {
    return NextResponse.json(
      { error: `Invalid action type: ${actionType}` },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  // Verify the action exists in the registry
  if (!PLUGIN_STEP_IMPORTERS[actionType]) {
    return NextResponse.json(
      { error: `Unknown action: ${actionType}` },
      { status: HttpStatus.NOT_FOUND }
    );
  }

  const apiKeyCtx = await validateApiKey(request);
  if ("error" in apiKeyCtx) {
    return NextResponse.json(
      { error: apiKeyCtx.error },
      { status: apiKeyCtx.status }
    );
  }

  const scopeError = requireScope(apiKeyCtx.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: apiKeyCtx.organizationId,
    scope: `execute:${actionType}`,
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

  try {
    // Try protocol action first (covers all protocol read/write tools)
    const meta = resolveProtocolMeta({ _actionType: actionType });
    if (meta) {
      const response = await withIdempotencyHeartbeat(idem, () =>
        executeProtocolAction(
          actionType,
          body,
          apiKeyCtx.organizationId,
          apiKeyCtx.apiKeyId
        )
      );
      return applyRateLimitHeaders(
        await recordIdempotentResponse(
          idem,
          response,
          await protocolActionDisposition(response)
        ),
        rateLimit
      );
    }

    // Non-protocol actions are not yet supported via direct execution. This
    // never broadcasts, so release the lock for a clean retry.
    return applyRateLimitHeaders(
      await recordIdempotentResponse(
        idem,
        NextResponse.json(
          {
            error: `Direct execution not supported for "${actionType}". Use workflow execution instead.`,
            hint: "Create a workflow with this action and execute it via workflow_execute.",
          },
          { status: HttpStatus.NOT_IMPLEMENTED }
        ),
        "release"
      ),
      rateLimit
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // A thrown error may have left a tx mid-broadcast: finalize as failed so a
    // retry replays the failure instead of re-broadcasting.
    return applyRateLimitHeaders(
      await recordIdempotentResponse(
        idem,
        NextResponse.json(
          { success: false, error: message },
          { status: HttpStatus.INTERNAL_SERVER_ERROR }
        ),
        "failed"
      ),
      rateLimit
    );
  }
}
