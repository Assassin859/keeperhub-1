ALTER TABLE "workflow_execution_logs" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action NOT VALID;
-- NOT VALID skips the validation scan, which would take a SHARE ROW EXCLUSIVE
-- lock on workflow_executions during deploy. The constraint still enforces on
-- every new insert; only pre-existing rows go unchecked, and those are all
-- NULL until the backfill runs. Operator runs VALIDATE CONSTRAINT after it.