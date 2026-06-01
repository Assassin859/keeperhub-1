/**
 * Catch-all 404 handler for unmatched /api/* paths.
 *
 * Next.js's default 404 returns an HTML page, which makes a wrong URL
 * look identical to a 401 when a builder is probing an API. This handler
 * returns the canonical {error, detail, request_id} envelope so unknown
 * routes are unambiguous and machine-parseable.
 *
 * Precedence: more specific route segments win over [...slug] in the
 * Next.js App Router, so existing catch-alls at deeper paths
 * (app/api/auth/[...all], app/api/execute/[...slug]) keep their own
 * behavior. This file only fires when no other route matches.
 *
 * Cache-Control: no-store so a transient prod misconfig (route file not
 * shipped, missing env var, etc.) does not get cached at the edge as a
 * permanent 404.
 */
import type { NextRequest } from "next/server";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { ErrorCategory, logUserError } from "@/lib/logging";

function notFoundResponse(request: NextRequest) {
  const { pathname } = new URL(request.url);
  // Emit a structured Loki line so frequently-probed unknown routes stay
  // diagnosable. This is a public surface that bots hammer with random
  // paths; a miss is a client error, not a system fault, so it must not
  // page on-call or burn a Sentry event per request. logUserError with no
  // error argument logs to console/Loki and bumps a bounded Prometheus
  // counter but skips captureException entirely. The unbounded path lives
  // in the message (extractContext keeps only the "[api-catch-all]"
  // prefix as the metric context), never in a metric label, so Prometheus
  // cardinality stays flat.
  logUserError(
    ErrorCategory.VALIDATION,
    `[api-catch-all] unknown route ${request.method} ${pathname}`,
    undefined,
    { method: request.method }
  );
  return apiError({
    status: 404,
    code: ApiErrorCodes.NOT_FOUND,
    detail: `Route ${request.method} ${pathname} not found`,
    requestHeaders: request.headers,
    headers: { "Cache-Control": "no-store" },
  });
}

export function GET(request: NextRequest) {
  return notFoundResponse(request);
}

export function POST(request: NextRequest) {
  return notFoundResponse(request);
}

export function PUT(request: NextRequest) {
  return notFoundResponse(request);
}

export function PATCH(request: NextRequest) {
  return notFoundResponse(request);
}

export function DELETE(request: NextRequest) {
  return notFoundResponse(request);
}

export function HEAD(request: NextRequest) {
  return notFoundResponse(request);
}

export function OPTIONS(request: NextRequest) {
  return notFoundResponse(request);
}
