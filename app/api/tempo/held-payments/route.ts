/**
 * GET /api/tempo/held-payments -- list the current org's held Tempo payments.
 * POST /api/tempo/held-payments -- sign and hold a Tempo transfer (Sign and Hold).
 * Owner-only (releasing held payments spends org funds). Server-paginated via
 * the shared Page interface; supports `?status=` and `?q=` (search over memo,
 * addresses, token, tx hash, id).
 */
import { NextResponse } from "next/server";
import { tempoHeldPaymentStatus } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { resolveCreatorContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { getOrgRole } from "@/lib/security/org-role";
import {
  countHeldPayments,
  type HeldPaymentListFilter,
  listHeldPayments,
  toHeldPaymentView,
} from "@/lib/tempo/held-payments";
import { executeHoldPayment } from "@/plugins/tempo/steps/hold-payment-core";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set<string>(tempoHeldPaymentStatus.enumValues);

export async function GET(request: Request): Promise<NextResponse> {
  const resolved = await resolveCreatorContext(request);
  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status }
    );
  }
  const role = await getOrgRole(resolved.userId, resolved.organizationId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Only organization owners can view held payments." },
      { status: 403 }
    );
  }

  try {
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && VALID_STATUSES.has(statusParam)
        ? (statusParam as (typeof tempoHeldPaymentStatus.enumValues)[number])
        : undefined;
    const search = url.searchParams.get("q") ?? undefined;
    const filter: HeldPaymentListFilter = { status, search };
    const req = parsePageRequest(url);

    const [rows, total] = await Promise.all([
      listHeldPayments(resolved.organizationId, {
        ...filter,
        limit: req.pageSize,
        offset: req.offset,
      }),
      countHeldPayments(resolved.organizationId, filter),
    ]);

    return NextResponse.json(
      buildPage(rows.map(toHeldPaymentView), total, req, url)
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Tempo Held] Failed to list held payments",
      error,
      { endpoint: "/api/tempo/held-payments", operation: "list" }
    );
    return NextResponse.json(
      { error: "Failed to list held payments" },
      { status: 500 }
    );
  }
}

type CreateHeldPaymentBody = {
  network?: string;
  tokenConfig?: string | Record<string, unknown>;
  amount?: string;
  recipientAddress?: string;
  memo?: string;
  broadcastMode?: "manual" | "schedule";
  broadcastAt?: string;
  validBefore?: string;
};

export async function POST(request: Request): Promise<NextResponse> {
  const resolved = await resolveCreatorContext(request);
  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status }
    );
  }
  const scopeError = requireScope(resolved.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
  }
  const role = await getOrgRole(resolved.userId, resolved.organizationId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Only organization owners can create held payments." },
      { status: 403 }
    );
  }

  let body: CreateHeldPaymentBody;
  try {
    body = (await request.json()) as CreateHeldPaymentBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !(
      body.network &&
      body.tokenConfig !== undefined &&
      body.amount &&
      body.recipientAddress
    )
  ) {
    return NextResponse.json(
      {
        error:
          "network, tokenConfig, amount, and recipientAddress are required",
      },
      { status: 400 }
    );
  }

  const result = await executeHoldPayment({
    organizationId: resolved.organizationId,
    userId: resolved.userId,
    network: body.network,
    tokenConfig: body.tokenConfig,
    amount: body.amount,
    recipientAddress: body.recipientAddress,
    memo: body.memo,
    broadcastMode: body.broadcastMode,
    broadcastAt: body.broadcastAt,
    validBefore: body.validBefore,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result, { status: 201 });
}
