-- Make the execution audit trail durable and reconstructable.
--
-- triggered_by_credential_type / triggered_by_credential_label: a durable
-- record of which credential triggered a run (webhook_key | org_api_key |
-- oauth | session | internal, plus a non-secret handle such as the key prefix
-- or internal caller name). The existing triggered_by_*_api_key_id FKs are
-- nulled when a key is revoked -- user webhook keys are hard-deleted -- which
-- erases "what did this credential run" exactly when an investigation needs
-- it. These columns survive revocation.
--
-- executed_workflow_hash: sha256 of the workflow definition (nodes + edges)
-- as it existed when the run was triggered. Ties a run to the exact definition
-- that produced it even after the workflow is later edited, and joins to
-- workflow_history.content_hash to resolve the full stored snapshot without
-- duplicating the graph on this high-volume table.

ALTER TABLE "workflow_executions"
  ADD COLUMN "triggered_by_credential_type" text;
--> statement-breakpoint
ALTER TABLE "workflow_executions"
  ADD COLUMN "triggered_by_credential_label" text;
--> statement-breakpoint
ALTER TABLE "workflow_executions"
  ADD COLUMN "executed_workflow_hash" text;
--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_executed_hash"
  ON "workflow_executions" ("executed_workflow_hash");
