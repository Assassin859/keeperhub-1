-- Extends security_audit_log so it can record deactivation/deletion cascades
-- as a general-purpose audit trail.
--
-- actor_label / organization_label: denormalized identity snapshots. The
-- actor_user_id and organization_id FKs are ON DELETE SET NULL, so a deletion
-- cascade (the very thing this audits) would otherwise erase its own
-- attribution when the user/org row is purged. These plain-text columns are
-- the durable fallback that survives the referenced row.
--
-- correlation_id: groups every row emitted by one logical operation, so a
-- cascade reads back as a single unit (filterable, served by the index below).
--
-- outcome: success rows are written inside the action's transaction; a
-- "failed" row is written out-of-band after a rollback, so a partial/failed
-- cascade still leaves a durable trace. Backfills existing rows to 'succeeded'.

ALTER TABLE "security_audit_log" ADD COLUMN "actor_label" text;
--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "organization_label" text;
--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "outcome" text DEFAULT 'succeeded' NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_security_audit_correlation_created" ON "security_audit_log" ("correlation_id","created_at");
