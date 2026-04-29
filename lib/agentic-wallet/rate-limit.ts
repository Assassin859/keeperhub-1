/**
 * Postgres-backed rate limiter. Per-(key, hour-bucket) counter via UPSERT.
 *
 * Phase 37 Wave 5 Task 20 replaces the in-memory limiter in
 * `lib/mcp/rate-limit.ts` for the `/provision` route. Hot-row contention is
 * acceptable at provision throughput (5/hour/IP). For higher-throughput
 * surfaces, shard the bucket key by minute or move to Redis.
 *
 * Cleanup: the `agentic-wallet-sweeper` cron deletes rows with
 * `bucket_start` older than 24h.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agenticWalletRateLimits } from "@/lib/db/schema";

export type RateLimitResult =
  | { allowed: true; count: number }
  | { allowed: false; retryAfter: number; count: number };

export async function incrementAndCheck(
  key: string,
  limit: number
): Promise<RateLimitResult> {
  // Atomic UPSERT-and-increment in one statement. The unique key is
  // (key, bucket_start) so concurrent calls for the same IP within the
  // same hour bucket serialize on the row lock.
  const rows = await db.execute<{ request_count: number }>(sql`
    INSERT INTO ${agenticWalletRateLimits} (key, bucket_start, request_count)
    VALUES (${key}, date_trunc('hour', now()), 1)
    ON CONFLICT (key, bucket_start)
    DO UPDATE SET request_count = ${agenticWalletRateLimits.requestCount} + 1
    RETURNING request_count
  `);
  const count = rows[0]?.request_count ?? 1;

  if (count > limit) {
    // Time until the bucket rolls over to the next hour. A single
    // `new Date()` guards against the sub-second race where minutes and
    // seconds cross an hour boundary between two separate reads.
    const now = new Date();
    const secondsPastHour = now.getMinutes() * 60 + now.getSeconds();
    // `Math.max(1, ...)` guards the edge case where the request lands at
    // XX:59:59.999 and the arithmetic would otherwise return 0.
    const retryAfter = Math.max(1, 3600 - secondsPastHour);
    return { allowed: false, retryAfter, count };
  }
  return { allowed: true, count };
}
