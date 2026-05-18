/**
 * Structured error envelope for REST API responses.
 *
 * KEEP-489: errors across REST + MCP have historically returned bare prose
 * strings ("Unauthorized", "Invalid input"). Builders branch on regex
 * matches against the message and break every time copy is updated.
 * Multiple hackathon teams independently reported this; AgentMesh, Aaether,
 * and ComputePool all reverse-engineered defensive parsers.
 *
 * The fix is to ship a stable envelope:
 *
 *   {
 *     "error": "wallet_not_configured",   // machine-readable snake_case
 *     "detail": "No wallet provisioned for chain 8453 in org X",
 *     "hint": "POST /api/integrations/wallet to provision",
 *     "docs": "https://docs.keeperhub.com/...",   // optional
 *     "request_id": "req_..."                     // optional
 *   }
 *
 * Callers branch on `error` (the stable code), surface `detail` for
 * debugging, and show `hint` to the developer. `docs` and `request_id` are
 * optional and may be omitted; clients MUST tolerate their absence.
 *
 * This module is the canonical helper. The MCP route uses its own JSON-RPC
 * envelope (KEEP-474, `lib/mcp/session-error.ts`) because JSON-RPC has a
 * different wire shape; both share the same `code` / `hint` philosophy.
 */
import { NextResponse } from "next/server";

export type ApiErrorBody = {
  error: string;
  detail: string;
  hint?: string;
  docs?: string;
  request_id?: string;
};

export type ApiErrorOptions = {
  status: number;
  code: string;
  detail: string;
  hint?: string;
  docs?: string;
  requestId?: string;
  headers?: HeadersInit;
};

/**
 * Build a structured error response. Returns a NextResponse with the
 * envelope as JSON. Callers should prefer this over `NextResponse.json({
 * error: "..." })` so external clients see a consistent shape.
 *
 * `code` MUST be snake_case and stable across releases — clients pin to it.
 * `detail` MAY include human-readable variable substitution (org id,
 * chain id, etc.) but MUST NOT include secrets, raw error messages from
 * upstream services, or stack traces.
 */
export function apiError(options: ApiErrorOptions): NextResponse {
  const body: ApiErrorBody = {
    error: options.code,
    detail: options.detail,
  };
  if (options.hint) {
    body.hint = options.hint;
  }
  if (options.docs) {
    body.docs = options.docs;
  }
  if (options.requestId) {
    body.request_id = options.requestId;
  }
  return NextResponse.json(body, {
    status: options.status,
    headers: options.headers,
  });
}

// Canonical codes — keep this list short and reuse aggressively. Per-route
// codes (e.g. WALLET_NOT_CONFIGURED) live next to the route that raises
// them, not here.
export const ApiErrorCodes = {
  UNAUTHORIZED: "unauthorized",
  INSUFFICIENT_SCOPE: "insufficient_scope",
  NOT_FOUND: "not_found",
  INVALID_INPUT: "invalid_input",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate_limited",
  INTERNAL_ERROR: "internal_error",
} as const;
