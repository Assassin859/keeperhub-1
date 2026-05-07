import { type SQL, sql } from "drizzle-orm";
import { workflows } from "../db/schema";

/**
 * Minimum price (USDC per call) at which a Marketplace-listed workflow's
 * executions stop counting toward the owner's monthly execution quota and
 * overage invoicing.
 *
 * Why a floor exists: without one, an owner could list a workflow at $0 (or
 * an irrationally low price), self-call it, and run unlimited "free"
 * executions while bypassing their plan limit.
 */
export const FREE_MARKETPLACE_BILLING_THRESHOLD_USDC = "0.05";

/**
 * Raw-SQL fragment for use inside `db.execute(sql\`...\`)` queries that count
 * workflow_executions for billing. The surrounding query MUST alias the
 * workflows table as `w` (matching the existing usage queries).
 *
 * Evaluates TRUE for rows that should count toward billing, FALSE for
 * Marketplace-listed workflows priced at or above the free-billing threshold.
 *
 * Built lazily so that simply importing this module does not require
 * `drizzle-orm`'s `sql` export to be present (some unit tests partially mock
 * the module).
 */
export function billableWorkflowRawSql(): SQL {
  return sql`
    NOT (
      w.is_listed = TRUE
      AND COALESCE(w.price_usdc_per_call::numeric, 0) >= ${sql.raw(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC)}::numeric
    )
  `;
}

/**
 * Drizzle query-builder fragment equivalent to {@link billableWorkflowRawSql}.
 * Use inside `and(...)` when querying workflows via the typed builder.
 */
export function billableWorkflowFilter(): SQL {
  return sql`
    NOT (
      ${workflows.isListed} = TRUE
      AND COALESCE(${workflows.priceUsdcPerCall}::numeric, 0) >= ${sql.raw(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC)}::numeric
    )
  `;
}
