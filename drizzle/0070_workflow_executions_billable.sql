-- Snapshot whether each workflow execution counts toward the owner org's
-- monthly execution quota and overage billing. Stamped at insert time so
-- subsequent listing/price changes cannot retroactively shift past rows in
-- or out of billable usage.
--
-- The threshold (0.05 USDC) is duplicated between this migration and
-- lib/billing/marketplace-billing.ts#FREE_MARKETPLACE_BILLING_THRESHOLD_USDC.
-- The trigger is the source of truth at insert time; any future change must
-- go through a new migration so historical rows stay frozen at the value
-- that was in effect when they were created.

ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "billable" boolean NOT NULL DEFAULT TRUE;
--> statement-breakpoint

-- Backfill existing rows from the workflow's current state. This is
-- deliberately a one-shot snapshot at deploy time; thereafter the trigger
-- below owns the value for new rows.
UPDATE "workflow_executions" we
   SET "billable" = NOT (
         w."is_listed" = TRUE
         AND COALESCE(w."price_usdc_per_call"::numeric, 0) >= 0.05::numeric
       )
  FROM "workflows" w
 WHERE we."workflow_id" = w."id";
--> statement-breakpoint

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
--> statement-breakpoint

DROP TRIGGER IF EXISTS "workflow_executions_set_billable" ON "workflow_executions";
--> statement-breakpoint

CREATE TRIGGER "workflow_executions_set_billable"
BEFORE INSERT ON "workflow_executions"
FOR EACH ROW
EXECUTE FUNCTION "set_workflow_execution_billable"();
