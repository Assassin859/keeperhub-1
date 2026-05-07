/**
 * Minimum price (USDC per call) at which a Marketplace-listed workflow's
 * executions stop counting toward the owner's monthly execution quota and
 * overage invoicing.
 *
 * Why a floor exists: without one, an owner could list a workflow at $0 (or
 * an irrationally low price), self-call it, and run unlimited "free"
 * executions while bypassing their plan limit.
 *
 * The actual gate runs in Postgres: a BEFORE INSERT trigger on
 * `workflow_executions` snapshots `billable = NOT (is_listed AND price >=
 * threshold)` at insert time so future listing changes cannot retroactively
 * shift past rows in or out of billable usage. See
 * drizzle/0070_workflow_executions_billable.sql for the trigger definition;
 * it is the source of truth for the threshold at insert time. This constant
 * is exposed for UI copy and documentation only.
 */
export const FREE_MARKETPLACE_BILLING_THRESHOLD_USDC = "0.05";

/**
 * Pure helper mirroring the Postgres trigger logic for use in unit tests
 * and any non-DB caller that needs to predict whether an execution would be
 * billable. Production code should rely on the stamped `billable` column.
 */
export function isWorkflowBillable(workflow: {
  isListed: boolean | null;
  priceUsdcPerCall: string | null;
}): boolean {
  if (workflow.isListed !== true) {
    return true;
  }
  const price = Number(workflow.priceUsdcPerCall ?? 0);
  return price < Number(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC);
}
