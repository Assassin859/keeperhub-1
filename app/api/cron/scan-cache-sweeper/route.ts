/**
 * GET /api/cron/scan-cache-sweeper
 *
 * HARDEN-02: Hourly cron that purges expired scan_results rows
 * (`scanned_at < NOW() - INTERVAL '1 hour'`). Authenticated via the
 * internal-service HMAC scheme; fails closed (non-scheduler callers → 401).
 *
 * Wave 0 throw-stub — the real implementation (db delete + auth check) lands
 * in 55-02. The stub satisfies `pnpm type-check` and makes
 * `tests/unit/scan-cache-sweeper.test.ts` fail (RED) as required by the
 * Wave 0 contract.
 */

export const dynamic = "force-dynamic";

export function GET(_request: Request): Promise<Response> {
  return Promise.reject(new Error("scan-cache-sweeper not implemented"));
}
