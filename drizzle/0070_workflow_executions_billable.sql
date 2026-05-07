-- Snapshot whether each workflow execution counts toward the owner org's
-- monthly execution quota and overage billing. Stamped at insert time so
-- subsequent listing/price changes cannot retroactively shift past rows in
-- or out of billable usage.
--
-- Apply prospectively: existing rows keep `billable = TRUE` (the column
-- default) so historical plan-quota usage does not shift at deploy. From
-- the moment the trigger is installed, new inserts are stamped from the
-- workflow's listing state at that moment and never change again.
--
-- The threshold (0.05 USDC) is duplicated between this migration and
-- lib/billing/marketplace-billing.ts#FREE_MARKETPLACE_BILLING_THRESHOLD_USDC.
-- The trigger is the source of truth at insert time; any future change
-- must go through a new migration so historical rows stay frozen at the
-- value that was in effect when they were created.
--
-- All wrapped in a single transaction so the column add and trigger
-- install land together; otherwise a new insert in the gap between the
-- two could default to TRUE when it should be FALSE.

BEGIN;

ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "billable" boolean NOT NULL DEFAULT TRUE;

CREATE OR REPLACE FUNCTION "set_workflow_execution_billable"()
RETURNS TRIGGER AS $$
BEGIN
  -- Always overwrite at insert time; callers cannot opt out, since this
  -- column exists for billing integrity. The default value (TRUE) is just
  -- a fallback in case the workflow row cannot be found.
  SELECT NOT (
           w."is_listed" = TRUE
           AND COALESCE(w."price_usdc_per_call"::numeric, 0) >= 0.05::numeric
         )
    INTO NEW."billable"
    FROM "workflows" w
   WHERE w."id" = NEW."workflow_id";
  NEW."billable" := COALESCE(NEW."billable", TRUE);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "workflow_executions_set_billable" ON "workflow_executions";

CREATE TRIGGER "workflow_executions_set_billable"
BEFORE INSERT ON "workflow_executions"
FOR EACH ROW
EXECUTE FUNCTION "set_workflow_execution_billable"();

COMMIT;
