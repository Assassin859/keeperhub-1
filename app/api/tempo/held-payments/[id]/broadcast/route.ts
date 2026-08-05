/**
 * POST /api/tempo/held-payments/[id]/broadcast -- release a held payment now.
 *
 * Session-only + step-up MFA (releasing moves funds on-chain). The row is loaded
 * org-scoped (404 for a missing row or another org's), fast-rejected before MFA
 * when it is not releasable, then released through the guarded claim so it can
 * never be broadcast twice.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  beginIdempotentFromRequest,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
} from "@/lib/idempotency";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { resolveCreatorContext } from "@/lib/middleware/auth-helpers";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { requireScope } from "@/lib/middleware/require-scope";
import {
  buildActor,
  buildAuditMetadata,
  recordAuditEvent,
} from "@/lib/security/audit-log";
import { getOrgRole } from "@/lib/security/org-role";
import { getHeldPaymentForOrg } from "@/lib/tempo/held-payments";
import { releaseHeldPaymentNow } from "@/lib/tempo/release-held-payment";

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/tempo/held-payments/[id]/broadcast";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { id } = await params;

  const resolved = await resolveCreatorContext(request);
  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status }
    );
  }
  if (resolved.authMethod !== "session") {
    return NextResponse.json(
      {
        error:
          "Releasing a held payment requires an interactive session with step-up verification.",
        code: "session_required",
      },
      { status: 403 }
    );
  }
  const scopeError = requireScope(resolved.scope, SCOPE_MCP_WRITE);
  if (scopeError) {
    return scopeError;
  }
  const role = await getOrgRole(resolved.userId, resolved.organizationId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Only organization owners can release held payments." },
      { status: 403 }
    );
  }

  // Fast, MFA-free rejections for a row that is missing or not releasable.
  const existing = await getHeldPaymentForOrg(id, resolved.organizationId);
  if (!existing) {
    return NextResponse.json(
      { error: "Held payment not found." },
      {
        status: 404,
      }
    );
  }
  if (existing.status !== "pending") {
    return NextResponse.json(
      {
        error: `Held payment is not pending (status: ${existing.status}); it cannot be broadcast.`,
        code: "not-pending",
      },
      { status: 409 }
    );
  }
  if (existing.validBefore <= Math.floor(Date.now() / 1000)) {
    return NextResponse.json(
      {
        error:
          "This held payment's validity window has closed; it can no longer be broadcast.",
        code: "expired",
      },
      { status: 410 }
    );
  }

  const idemBody = { paymentId: id };
  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: resolved.organizationId,
    scope: "tempo-held-payment-broadcast",
    requestBody: idemBody,
  });
  if (idem) {
    const early = idempotencyEarlyResponse(idem);
    if (early) {
      return NextResponse.json(early.body, { status: early.status });
    }
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    code?: string;
    emailOtp?: string;
    signature?: string;
  };
  const authorized = await authorizeAction({
    session,
    action: STEP_UP_ACTIONS.tempoHeldPaymentBroadcast,
    roleFloor: "none",
    body,
    headers: request.headers,
  });
  if (!authorized.ok) {
    return authorized.response;
  }

  try {
    const result = await releaseHeldPaymentNow({
      paymentId: id,
      organizationId: resolved.organizationId,
      userId: resolved.userId,
    });
    if (!result.ok) {
      const status = mapReleaseFailureStatus(result.reason);
      return NextResponse.json(
        { error: result.error, code: result.reason },
        { status }
      );
    }
    await recordAuditEvent({
      actor: buildActor({
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        authMethod: resolved.authMethod,
        apiKeyId: resolved.apiKeyId,
      }),
      action: "tempo_held_payment.broadcast",
      resourceType: "tempo_held_payment",
      resourceId: id,
      metadata: buildAuditMetadata(request),
    });
    return recordIdempotentResponse(
      idem,
      NextResponse.json({
        ok: true,
        status: "confirmed",
        transactionHash: result.transactionHash,
      })
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Tempo Held] Broadcast failed",
      error,
      {
        endpoint: ENDPOINT,
        operation: "broadcast",
      }
    );
    return NextResponse.json(
      { error: "Failed to broadcast held payment" },
      { status: 500 }
    );
  }
}

function mapReleaseFailureStatus(
  reason: "not-found" | "expired" | "not-pending" | "broadcast-failed"
): number {
  switch (reason) {
    case "not-found":
      return 404;
    case "expired":
      return 410;
    case "not-pending":
      return 409;
    default:
      return 502;
  }
}
