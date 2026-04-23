/**
 * Scheduled sweeper for the agentic-wallet tables (Phase 37 fix B2/B3,
 * Task 15). Expected trigger cadence: every 5 minutes.
 *
 * Jobs:
 *   1. Mark wallet_approval_requests rows past expires_at as "expired"
 *      (status flip + resolvedAt stamp). The UPDATE is guarded by
 *      status='pending' -- same race-fix pattern as the lazy-flip in
 *      checkApprovalForResolve (Task 13) -- so a row already resolved to
 *      approved/rejected out-of-band is NOT overwritten to expired just
 *      because its TTL elapsed.
 *   2. Delete terminal rows (expired/approved/rejected) whose resolved_at is
 *      older than 7 days.
 *   3. Delete agentic_wallet_rate_limits rows whose bucket_start is older
 *      than 24h.
 *   4. Delete agentic_wallet_daily_spend rows whose day_utc is older than
 *      2 days (fix-pack-2 R1). Two-day retention keeps yesterday's row
 *      visible for debugging without unbounded growth.
 *
 * Deployment: this endpoint is an HTTP GET handler. It must be invoked by an
 * external scheduler (Kubernetes CronJob, GitHub Actions scheduled workflow,
 * or equivalent) every 5 minutes. Configure the scheduler to send
 * `Authorization: Bearer $CRON_SECRET` in production; in dev/test the auth
 * check is bypassed so local testing via curl works.
 */
import { and, eq, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agenticWalletDailySpend,
  agenticWalletRateLimits,
  walletApprovalRequests,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export const dynamic = "force-dynamic";

const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

type SweeperResponse = {
  expired: number;
  pruned: number;
  prunedBuckets: number;
  prunedDailySpend: number;
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    const provided = request.headers.get("authorization");
    const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
    if (!process.env.CRON_SECRET || provided !== expected) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();

  try {
    // 1. Expire stale pending rows. The status='pending' guard is essential:
    // without it, a row already resolved to approved/rejected could be
    // overwritten to expired when its TTL passes.
    const expiredRows = await db
      .update(walletApprovalRequests)
      .set({ status: "expired", resolvedAt: now })
      .where(
        and(
          eq(walletApprovalRequests.status, "pending"),
          lt(walletApprovalRequests.expiresAt, now)
        )
      )
      .returning({ id: walletApprovalRequests.id });

    // 2. Prune terminal rows older than 7 days.
    const terminalCutoff = new Date(now.getTime() - TERMINAL_RETENTION_MS);
    const prunedRows = await db
      .delete(walletApprovalRequests)
      .where(
        and(
          or(
            eq(walletApprovalRequests.status, "expired"),
            eq(walletApprovalRequests.status, "approved"),
            eq(walletApprovalRequests.status, "rejected")
          ),
          lt(walletApprovalRequests.resolvedAt, terminalCutoff)
        )
      )
      .returning({ id: walletApprovalRequests.id });

    // 3. Prune rate-limit buckets older than 24h.
    const rateCutoff = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS);
    const prunedBuckets = await db
      .delete(agenticWalletRateLimits)
      .where(lt(agenticWalletRateLimits.bucketStart, rateCutoff))
      .returning({ key: agenticWalletRateLimits.key });

    // 4. Prune daily-spend rows older than 2 days (fix-pack-2 R1). The cap
    // is enforced on today's row only; yesterday's row is retained for
    // short-term debugging and then dropped. Cutoff is computed JS-side as
    // a UTC date string (YYYY-MM-DD) so drizzle passes it through the same
    // parameterised path as other lt(...) comparisons.
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const cutoffDate = twoDaysAgo.toISOString().slice(0, 10);
    const prunedDailySpend = await db
      .delete(agenticWalletDailySpend)
      .where(lt(agenticWalletDailySpend.dayUtc, cutoffDate))
      .returning({ subOrgId: agenticWalletDailySpend.subOrgId });

    const body: SweeperResponse = {
      expired: expiredRows.length,
      pruned: prunedRows.length,
      prunedBuckets: prunedBuckets.length,
      prunedDailySpend: prunedDailySpend.length,
    };
    return Response.json(body);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[Agentic] sweeper failed", error, {
      endpoint: "/api/cron/agentic-wallet-sweeper",
    });
    return Response.json({ error: "Sweeper failed" }, { status: 500 });
  }
}
