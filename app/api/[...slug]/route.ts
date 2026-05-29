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
import { ErrorCategory, logSystemWarn } from "@/lib/logging";

function notFoundResponse(request: NextRequest) {
  const { pathname } = new URL(request.url);
  // Emit a structured warn so Loki and Sentry surface frequently-probed
  // unknown routes. Without this, the catch-all silently absorbs every
  // misrouted client - which is exactly the diagnostic gap that
  // motivated the ticket. Bots probe noisily, so consider sampling here
  // if log volume becomes a concern.
  logSystemWarn(
    ErrorCategory.VALIDATION,
    "[api-catch-all] unknown route",
    new Error("api_route_not_found"),
    {
      path: pathname,
      method: request.method,
    }
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
