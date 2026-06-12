-- One row per saved workflow version, powering the change-history timeline,
-- version load (?version=N), and restore. Complements security_audit_log:
-- that table keeps a lightweight cross-resource "who did what" event per
-- change; this holds the heavy per-version snapshot needed to diff and
-- restore. It mirrors the audit-log actor capture (changed_by_user_id,
-- auth_method, created_at) so "who did it" is answerable here too.
--
-- snapshot stores the full definition incl. edges (structural -- the executor
-- builds its run graph from them). change is the deep-diff vs the previous
-- version; both it and content_hash are computed over the meaningful
-- definition only (cosmetic ReactFlow state stripped in
-- lib/workflow/content-hash.ts). content_hash joins to
-- workflow_executions.executed_workflow_hash. version is a per-workflow
-- counter (unique with workflow_id).

CREATE TABLE "workflow_history" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_id" text NOT NULL,
  "organization_id" text,
  "version" integer NOT NULL,
  "changed_by_user_id" text,
  "auth_method" text NOT NULL,
  "source" text NOT NULL,
  "snapshot" jsonb,
  "change" jsonb,
  "content_hash" text NOT NULL,
  "previous_version" integer,
  "previous_hash" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_history_workflow_id_workflows_id_fk"
    FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade,
  CONSTRAINT "workflow_history_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE set null,
  CONSTRAINT "workflow_history_changed_by_user_id_users_id_fk"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_history_workflow_version" ON "workflow_history" ("workflow_id","version");
--> statement-breakpoint
CREATE INDEX "idx_workflow_history_content_hash" ON "workflow_history" ("content_hash");
