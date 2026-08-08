import "server-only";

import {
  checkIpRateLimit,
  getClientIp,
  type RateLimitResult,
} from "@/lib/mcp/rate-limit";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

/** Anonymous / invalid-token share polls (per IP, per pod). */
export const EXEC_STATUS_ANON_IP_LIMIT = 60;
/** Real session / kh_ / OAuth callers get a higher poll budget. */
export const EXEC_STATUS_AUTH_IP_LIMIT = 300;
export const EXEC_STATUS_IP_WINDOW_MS = 60_000;

/**
 * Always-on IP rate limit for execution status share surfaces (JSON + HTML).
 * Bucket by real dual-auth principal, never by Authorization/cookie presence —
 * a garbage Bearer must stay on the anonymous budget.
 */
export async function checkExecutionStatusIpRateLimit(
  request: Request
): Promise<RateLimitResult> {
  const authContext = await getDualAuthContext(request);
  const authenticated =
    !("error" in authContext) &&
    !authContext.isAnonymous &&
    Boolean(authContext.userId || authContext.organizationId);
  const limit = authenticated
    ? EXEC_STATUS_AUTH_IP_LIMIT
    : EXEC_STATUS_ANON_IP_LIMIT;
  const ip = getClientIp(request);
  const key = `exec-status:${authenticated ? "auth" : "anon"}:${ip}`;
  return checkIpRateLimit(key, limit, EXEC_STATUS_IP_WINDOW_MS);
}
