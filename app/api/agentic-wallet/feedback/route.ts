/**
 * POST /api/agentic-wallet/feedback
 *
 * HMAC-authenticated entry point that lets a caller wallet submit ERC-8004
 * feedback for a workflow execution it paid for. The route is the
 * orchestrator: it builds the off-chain feedback JSON, computes its
 * keccak256 hash, encodes the giveFeedback() call, signs the unsigned EVM
 * tx via Turnkey (policy-gated to ReputationRegistry::giveFeedback on
 * Ethereum mainnet only), and broadcasts via the configured eth-mainnet
 * RPC. Returns the new feedback row id, on-chain tx hash, and the public
 * URL of the canonical feedback JSON (the feedbackURI committed on-chain).
 *
 * Request body:
 *   {
 *     executionId: string,         // workflow_executions.id
 *     value: string | number,      // raw int128 (string for safety)
 *     valueDecimals: number,       // 0..18
 *     comment?: string,            // optional, surfaced in feedbackURI JSON
 *     agentChainId?: number,       // default 1 (Ethereum mainnet)
 *     agentId?: string,            // default KEEPERHUB_ERC_8004_AGENT_ID
 *   }
 *
 * Response:
 *   200 { feedbackId, txHash, publicUrl }
 *   400 BAD_INPUT
 *   401 missing/invalid HMAC
 *   403 NOT_PAYER  -- caller's wallet did not pay for the referenced execution
 *   404 EXECUTION_NOT_FOUND
 *   409 ALREADY_RATED -- caller already rated this execution
 *   502 TURNKEY_UPSTREAM | RPC_UPSTREAM
 *
 * Anti-spam: payerAddress on the workflow_payments row must match the
 * caller's wallet address. ERC-8004 contract itself blocks self-feedback
 * (agent owner can't rate themselves) -- we don't replicate that gate
 * here, the chain enforces it.
 */
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { createPublicClient, type Hex, http, serializeTransaction } from "viem";
import { mainnet } from "viem/chains";
import {
  ERC_8004_REPUTATION_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
  KEEPERHUB_ERC_8004_AGENT_ID,
} from "@/lib/agentic-wallet/constants";
import {
  buildFeedbackUriContent,
  buildGiveFeedbackCalldata,
  hashFeedbackContent,
} from "@/lib/agentic-wallet/erc-8004";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";
import {
  PolicyBlockedError,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign";
import {
  broadcastSignedTransaction,
  signEthereumTransaction,
} from "@/lib/agentic-wallet/sign-eth-tx";
import { db } from "@/lib/db";
import {
  agenticWallets,
  feedback,
  workflowExecutions,
  workflowPayments,
  workflows,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";

export const dynamic = "force-dynamic";

type FeedbackRequestBody = {
  executionId?: unknown;
  value?: unknown;
  valueDecimals?: unknown;
  comment?: unknown;
  agentChainId?: unknown;
  agentId?: unknown;
};

type ValidatedInput = {
  executionId: string;
  value: bigint;
  valueDecimals: number;
  comment?: string;
  agentChainId: number;
  agentId: bigint;
};

function badRequest(message: string, code = "BAD_INPUT"): NextResponse {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

// Hoisted to module scope per useTopLevelRegex (avoids re-parsing the
// pattern on every parse call).
const INT_LITERAL_RE = /^-?\d+$/;

function tryParseBigInt(value: unknown): bigint | null {
  if (typeof value === "string" && INT_LITERAL_RE.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  return null;
}

function validateInput(body: FeedbackRequestBody): ValidatedInput | string {
  if (typeof body.executionId !== "string" || body.executionId.length === 0) {
    return "executionId required";
  }
  const value = tryParseBigInt(body.value);
  if (value === null) {
    return "value must be an integer (string or number)";
  }
  // int128 range. BigInt literals (1n) are ES2020 only; this project
  // targets ES2017 so we go through the constructor.
  const INT128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1);
  const INT128_MIN = -(BigInt(1) << BigInt(127));
  if (value > INT128_MAX || value < INT128_MIN) {
    return "value outside int128 range";
  }
  if (
    typeof body.valueDecimals !== "number" ||
    !Number.isInteger(body.valueDecimals) ||
    body.valueDecimals < 0 ||
    body.valueDecimals > 18
  ) {
    return "valueDecimals must be an integer in [0, 18]";
  }
  if (
    body.comment !== undefined &&
    (typeof body.comment !== "string" || body.comment.length > 2000)
  ) {
    return "comment must be a string <= 2000 chars";
  }
  // Default to Ethereum mainnet + KeeperHub agent id; allow override per
  // user instruction "any agent" (Turnkey policy does not constrain agentId).
  let agentChainId: number;
  if (body.agentChainId === undefined) {
    agentChainId = ETHEREUM_MAINNET_CHAIN_ID;
  } else if (
    typeof body.agentChainId === "number" &&
    Number.isInteger(body.agentChainId)
  ) {
    agentChainId = body.agentChainId;
  } else {
    return "agentChainId must be an integer";
  }
  // Today the Turnkey signTransaction policy only allows chain_id=1 for the
  // ReputationRegistry. Reject any other agentChainId at the application
  // layer before the Turnkey roundtrip wastes time.
  if (agentChainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    return `agentChainId ${agentChainId} not supported (only ${ETHEREUM_MAINNET_CHAIN_ID} today)`;
  }
  const agentIdRaw = body.agentId ?? KEEPERHUB_ERC_8004_AGENT_ID;
  const agentId = tryParseBigInt(agentIdRaw);
  if (agentId === null || agentId < BigInt(0)) {
    return "agentId must be a non-negative integer";
  }
  return {
    executionId: body.executionId,
    value,
    valueDecimals: body.valueDecimals,
    comment: typeof body.comment === "string" ? body.comment : undefined,
    agentChainId,
    agentId,
  };
}

type WalletResolveResult =
  | { ok: true; subOrgId: string; walletAddress: `0x${string}` }
  | { ok: false; status: number; error: string };

async function resolveWallet(subOrgId: string): Promise<WalletResolveResult> {
  const rows = await db
    .select({
      walletAddress: agenticWallets.walletAddressBase,
    })
    .from(agenticWallets)
    .where(eq(agenticWallets.subOrgId, subOrgId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 401, error: "Sub-org not found" };
  }
  return {
    ok: true,
    subOrgId,
    walletAddress: row.walletAddress as `0x${string}`,
  };
}

type ExecutionVerifyResult =
  | { ok: true; workflowId: string; workflowSlug: string | null }
  | { ok: false; status: number; error: string; code: string };

async function verifyExecutionAndPayer(args: {
  executionId: string;
  walletAddress: `0x${string}`;
}): Promise<ExecutionVerifyResult> {
  const rows = await db
    .select({
      executionId: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
      executionStatus: workflowExecutions.status,
      workflowSlug: workflows.listedSlug,
      payerAddress: workflowPayments.payerAddress,
    })
    .from(workflowExecutions)
    .leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .leftJoin(
      workflowPayments,
      eq(workflowPayments.executionId, workflowExecutions.id)
    )
    .where(eq(workflowExecutions.id, args.executionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "Execution not found",
      code: "EXECUTION_NOT_FOUND",
    };
  }
  // Allow rating successful and errored executions, but not still-running
  // ones (caller might retract). cancelled/error are still rate-able since
  // they represent a real interaction.
  if (row.executionStatus === "running" || row.executionStatus === "pending") {
    return {
      ok: false,
      status: 409,
      error: "Execution still in progress",
      code: "EXECUTION_NOT_FINAL",
    };
  }
  // payerAddress is null for free executions; we permit free rating so
  // the agent score moves on free workflows too. For paid executions the
  // payer must match.
  if (
    row.payerAddress !== null &&
    row.payerAddress !== undefined &&
    row.payerAddress.toLowerCase() !== args.walletAddress.toLowerCase()
  ) {
    return {
      ok: false,
      status: 403,
      error: "Caller wallet did not pay for this execution",
      code: "NOT_PAYER",
    };
  }
  return {
    ok: true,
    workflowId: row.workflowId,
    workflowSlug: row.workflowSlug ?? null,
  };
}

async function ensureNotAlreadyRated(args: {
  executionId: string;
  payerWallet: string;
}): Promise<NextResponse | null> {
  const existing = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(
      and(
        eq(feedback.executionId, args.executionId),
        eq(feedback.payerWallet, args.payerWallet.toLowerCase())
      )
    )
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      {
        error: "Wallet has already submitted feedback for this execution",
        code: "ALREADY_RATED",
        feedbackId: existing[0]?.id,
      },
      { status: 409 }
    );
  }
  return null;
}

async function buildAndSignTx(args: {
  subOrgId: string;
  walletAddress: `0x${string}`;
  agentChainId: number;
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  feedbackId: string;
  feedbackHash: Hex;
}): Promise<{ signedTx: Hex; publicBaseUrl: string }> {
  const publicBaseUrl =
    process.env.KEEPERHUB_PUBLIC_BASE_URL ?? "https://app.keeperhub.com";
  const feedbackURI = `${publicBaseUrl}/api/feedback/${args.feedbackId}`;

  const calldata = buildGiveFeedbackCalldata({
    agentId: args.agentId,
    value: args.value,
    valueDecimals: args.valueDecimals,
    feedbackURI,
    feedbackHash: args.feedbackHash,
  });

  const rpcUrl = getRpcUrlByChainId(args.agentChainId);
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  // Live network reads -- nonce + gas estimate + fee estimate. Each one
  // hits the upstream RPC; we await sequentially to keep error surfacing
  // crisp (and Promise.all would still be sequential because of viem's
  // single-connection transport in practice).
  const nonce = await publicClient.getTransactionCount({
    address: args.walletAddress,
    blockTag: "pending",
  });
  const gas = await publicClient.estimateGas({
    account: args.walletAddress,
    to: ERC_8004_REPUTATION_REGISTRY_ADDRESS,
    data: calldata,
    value: BigInt(0),
  });
  // 20% headroom over the estimate -- defends against mid-mempool gas
  // bumps invalidating the broadcast. Cheap insurance on a $3-10 tx.
  const gasWithHeadroom = (gas * BigInt(12)) / BigInt(10);
  const fees = await publicClient.estimateFeesPerGas();

  const unsignedTx = serializeTransaction({
    chainId: args.agentChainId,
    type: "eip1559",
    nonce,
    to: ERC_8004_REPUTATION_REGISTRY_ADDRESS,
    value: BigInt(0),
    data: calldata,
    gas: gasWithHeadroom,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  const { signedTransaction } = await signEthereumTransaction({
    subOrgId: args.subOrgId,
    walletAddress: args.walletAddress,
    // Turnkey expects the unsigned RLP without the 0x prefix.
    unsignedTransactionHex: unsignedTx.startsWith("0x")
      ? unsignedTx.slice(2)
      : unsignedTx,
  });
  return { signedTx: signedTransaction, publicBaseUrl };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const verify = await verifyHmacRequest(request, rawBody);
  if (!verify.ok) {
    return NextResponse.json(
      { error: verify.error },
      { status: verify.status }
    );
  }

  let parsed: FeedbackRequestBody;
  try {
    parsed = JSON.parse(rawBody) as FeedbackRequestBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
  const validated = validateInput(parsed);
  if (typeof validated === "string") {
    return badRequest(validated);
  }

  const wallet = await resolveWallet(verify.subOrgId);
  if (!wallet.ok) {
    return NextResponse.json(
      { error: wallet.error },
      { status: wallet.status }
    );
  }

  const exec = await verifyExecutionAndPayer({
    executionId: validated.executionId,
    walletAddress: wallet.walletAddress,
  });
  if (!exec.ok) {
    return NextResponse.json(
      { error: exec.error, code: exec.code },
      { status: exec.status }
    );
  }

  const dup = await ensureNotAlreadyRated({
    executionId: validated.executionId,
    payerWallet: wallet.walletAddress,
  });
  if (dup) {
    return dup;
  }

  // Insert feedback row first -- we need the id for the feedbackURI before
  // we can compute the hash and build the giveFeedback call. We update the
  // row with feedbackHash + txHash + status="broadcast" once we've signed
  // and broadcast. If signing or broadcast fails, the row stays at status=
  // "pending" with the error column set, providing a debug breadcrumb
  // without re-issuing an id (the URI is already committed-to nowhere).
  const inserted = await db
    .insert(feedback)
    .values({
      executionId: validated.executionId,
      workflowId: exec.workflowId,
      agentChainId: validated.agentChainId,
      agentId: validated.agentId.toString(),
      payerWallet: wallet.walletAddress.toLowerCase(),
      value: validated.value.toString(),
      valueDecimals: validated.valueDecimals,
      comment: validated.comment ?? null,
      txChainId: validated.agentChainId,
      status: "pending",
    })
    .returning({ id: feedback.id, createdAt: feedback.createdAt });
  const newRow = inserted[0];
  if (!newRow) {
    return NextResponse.json(
      { error: "Failed to insert feedback row" },
      { status: 500 }
    );
  }

  // Compute the canonical feedbackURI JSON + its keccak256. The hash MUST
  // match what `/api/feedback/[id]` will serve later for the on-chain
  // commitment to verify.
  const content = buildFeedbackUriContent({
    agentChainId: validated.agentChainId,
    agentId: validated.agentId,
    clientAddress: wallet.walletAddress,
    createdAt: newRow.createdAt,
    value: validated.value,
    valueDecimals: validated.valueDecimals,
    comment: validated.comment,
    workflowSlug: exec.workflowSlug ?? undefined,
    executionId: validated.executionId,
  });
  const feedbackHash = hashFeedbackContent(content);

  let signedTx: Hex;
  let publicBaseUrl: string;
  try {
    const result = await buildAndSignTx({
      subOrgId: wallet.subOrgId,
      walletAddress: wallet.walletAddress,
      agentChainId: validated.agentChainId,
      agentId: validated.agentId,
      value: validated.value,
      valueDecimals: validated.valueDecimals,
      feedbackId: newRow.id,
      feedbackHash,
    });
    signedTx = result.signedTx;
    publicBaseUrl = result.publicBaseUrl;
  } catch (err) {
    await db
      .update(feedback)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(feedback.id, newRow.id));
    if (err instanceof PolicyBlockedError) {
      return NextResponse.json(
        { error: err.message, code: "POLICY_BLOCKED", feedbackId: newRow.id },
        { status: 403 }
      );
    }
    if (err instanceof TurnkeyUpstreamError) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[feedback] Turnkey signing failed",
        err,
        { endpoint: "/api/agentic-wallet/feedback", feedbackId: newRow.id }
      );
      return NextResponse.json(
        {
          error: "Upstream signing failed",
          code: "TURNKEY_UPSTREAM",
          feedbackId: newRow.id,
        },
        { status: 502 }
      );
    }
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[feedback] Build/sign failed",
      err,
      { endpoint: "/api/agentic-wallet/feedback", feedbackId: newRow.id }
    );
    return NextResponse.json(
      { error: "Failed to prepare or sign tx", feedbackId: newRow.id },
      { status: 500 }
    );
  }

  let txHash: Hex;
  try {
    const broadcast = await broadcastSignedTransaction({
      signedTransaction: signedTx,
      chainId: validated.agentChainId,
    });
    txHash = broadcast.txHash;
  } catch (err) {
    await db
      .update(feedback)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(feedback.id, newRow.id));
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[feedback] RPC broadcast failed",
      err,
      { endpoint: "/api/agentic-wallet/feedback", feedbackId: newRow.id }
    );
    return NextResponse.json(
      {
        error: "Broadcast failed",
        code: "RPC_UPSTREAM",
        feedbackId: newRow.id,
      },
      { status: 502 }
    );
  }

  await db
    .update(feedback)
    .set({
      status: "broadcast",
      txHash,
      feedbackHash,
      broadcastAt: new Date(),
    })
    .where(eq(feedback.id, newRow.id));

  return NextResponse.json({
    feedbackId: newRow.id,
    txHash,
    publicUrl: `${publicBaseUrl}/api/feedback/${newRow.id}`,
  });
}
