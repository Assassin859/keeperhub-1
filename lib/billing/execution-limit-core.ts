import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Shared, server-only-free core for the monthly execution-limit check. Both the
 * Next billing path (lib/billing/plans-server.ts) and the standalone executor
 * (keeperhub-executor/billing-guard.ts) use these so the count query and the
 * allow/overage/block decision cannot drift. Each caller keeps its own result
 * shape and its own debt source (the route's is Stripe-aware and server-only;
 * the executor's is a plain active-debt sum), which is why those stay per-side.
 */

export const MINIMUM_EXECUTION_FLOOR = 100;

export function startOfCurrentMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function effectiveExecutionLimit(
  maxExecutionsPerMonth: number,
  debtExecutions: number
): number {
  return Math.max(
    MINIMUM_EXECUTION_FLOOR,
    maxExecutionsPerMonth - debtExecutions
  );
}

/**
 * Count an org's billable executions in the current month: billable workflow
 * executions plus direct (MCP/API) executions. Raw SQL (rather than the query
 * builder) so the same statement runs identically under the app db and the
 * executor's standalone db handle.
 */
export async function countMonthlyExecutions<
  TSchema extends Record<string, unknown>,
>(
  db: PostgresJsDatabase<TSchema>,
  organizationId: string,
  since: Date = startOfCurrentMonthUtc()
): Promise<number> {
  const result = await db.execute<{ count: number }>(
    sql`SELECT
          (
            SELECT COUNT(*)
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
               AND we.started_at >= ${since.toISOString()}
               AND we.billable = TRUE
          )
          +
          (
            SELECT COUNT(*)
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
               AND de.created_at >= ${since.toISOString()}
          ) AS count`
  );

  return result[0]?.count ?? 0;
}

export type ExecutionLimitOutcome =
  | "blocked_debt"
  | "within_limit"
  | "overage"
  | "blocked_limit";

/**
 * The allow/overage/block decision for a non-unlimited plan. Callers handle the
 * unlimited (maxExecutionsPerMonth === -1) case before reaching here, since it
 * intentionally skips the debt and count queries.
 */
export function decideExecutionLimit(params: {
  maxExecutionsPerMonth: number;
  used: number;
  debtExecutions: number;
  overageEnabled: boolean;
  subscriptionActive: boolean;
}): ExecutionLimitOutcome {
  if (params.debtExecutions > 0 && params.overageEnabled) {
    return "blocked_debt";
  }
  if (params.used < params.maxExecutionsPerMonth) {
    return "within_limit";
  }
  if (params.overageEnabled && params.subscriptionActive) {
    return "overage";
  }
  return "blocked_limit";
}
