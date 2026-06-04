-- Durable forensic record of sensitive account/security actions: who did
-- what, when, from where, and -- for mutations -- a structured before/after
-- diff (deep-diff change records) in the `diff` jsonb column. Pairs with the
-- out-of-band email alerts: the email is the real-time signal, this table is
-- the queryable history.
--
-- actor_user_id and organization_id are ON DELETE SET NULL so purging a user
-- or org never erases the trail of what they did. action is plain text (not a
-- pgEnum) so adding a new audited action needs no follow-up migration.
--
-- Indexes trail with created_at: audit reads are always "filter by one
-- dimension, newest first", and Postgres serves ORDER BY created_at DESC from
-- an ascending composite via a backward scan, so filter + sort are one index
-- with no separate sort step.

CREATE TABLE "security_audit_log" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_user_id" text,
  "organization_id" text,
  "auth_method" text NOT NULL,
  "api_key_id" text,
  "action" text NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "diff" jsonb,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "security_audit_log_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "security_audit_log_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX "idx_security_audit_org_created" ON "security_audit_log" ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_actor_created" ON "security_audit_log" ("actor_user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_resource_created" ON "security_audit_log" ("resource_type","resource_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_action_created" ON "security_audit_log" ("action","created_at");
