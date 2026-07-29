-- Pay As You Go: per-org config (spend caps + enable anchor) and per-execution
-- payment history. New empty tables plus their indexes; no lock of consequence,
-- so no @requires-db-prep. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "payg_config" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"daily_cap_raw" text DEFAULT '0' NOT NULL,
	"period_cap_raw" text DEFAULT '0' NOT NULL,
	"chain_id" integer DEFAULT 8453 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payg_config_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "payg_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "payg_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"amount_raw" text NOT NULL,
	"tx_hash" text,
	"chain_id" integer NOT NULL,
	"payer_address" text NOT NULL,
	"treasury_address" text NOT NULL,
	"status" text DEFAULT 'settled' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payg_payments_org_execution" UNIQUE("organization_id","execution_id"),
	CONSTRAINT "payg_payments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "idx_payg_config_org" ON "payg_config" USING btree ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_payg_payments_org_created" ON "payg_payments" USING btree ("organization_id","created_at");
