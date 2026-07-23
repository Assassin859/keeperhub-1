/**
 * GET /api/tempo/held-payments -- list the current org's held Tempo payments.
 * Owner-only (releasing held payments spends org funds). Server-paginated via
 * the shared Page interface; supports `?status=` and `?q=` (search over memo,
 * addresses, token, tx hash, id).
 */
import { NextResponse } from "next/server";
import { tempoHeldPaymentStatus } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveCreatorContext } from "@/lib/middleware/auth-helpers";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { getOrgRole } from "@/lib/security/org-role";
import {
  countHeldPayments,
  type HeldPaymentListFilter,
  listHeldPayments,
  toHeldPaymentView,
} from "@/lib/tempo/held-payments";

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
