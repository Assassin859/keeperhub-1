/**
 * Minimum price (USDC per call) at which a successful Marketplace payment
 * makes that execution exempt from the owner's monthly execution quota and
 * overage invoicing.
 *
 * The exemption is gated on actual payment receipt, not on the workflow's
 * listing state alone:
 *
 *   billable = TRUE by default on every workflow_executions insert; the
 *   marketplace call route flips it to FALSE only after `recordPayment`
 *   succeeds and the recorded price is at or above this threshold. Owner-
 *   initiated runs (manual Run, scheduled, block, event, webhook, direct
 *   API) never reach that flip and always count toward the quota.
 *
 * Why a floor exists: without one, an owner could publish a workflow at $0
 * (or any irrationally low price), self-call it through the marketplace,
 * and accumulate "free" executions while bypassing their plan limit.
 *
 * See drizzle/0070_workflow_executions_billable.sql for the column
 * definition and app/api/mcp/workflows/[slug]/call/route.ts for the flip.
 */
export const FREE_MARKETPLACE_BILLING_THRESHOLD_USDC = "0.05";
