import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { workflowExecutions } from "@/lib/db/schema";

/**
 * Shared concurrency back-pressure check. Server-only-free and db-agnostic so
 * both the Next routes (via app/api/execute/_lib/concurrency-limit) and the
 * standalone executor enforce the same cap regardless of execution mode.
 */

const DEFAULT_LIMIT = 500;

export function resolveMaxConcurrent(): number {
  const envValue = process.env.MAX_CONCURRENT_WORKFLOW_EXECUTIONS;
  if (!envValue) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isNaN(parsed) ? DEFAULT_LIMIT : parsed;
}

export type ConcurrencyLimitResult =
  | { allowed: true }
  | { allowed: false; running: number; limit: number };

/**
 * Soft cap: the count-then-admit check is not atomic, so under burst load
 * concurrent callers may all pass before any new execution is inserted. The
 * goal is back-pressure, not a hard guarantee.
 */
export async function checkConcurrencyLimit<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  limit: number = resolveMaxConcurrent()
): Promise<ConcurrencyLimitResult> {
  const [result] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.status, "running"));

  const running = result?.count ?? 0;

  if (running >= limit) {
    return { allowed: false, running, limit };
  }

  return { allowed: true };
}
