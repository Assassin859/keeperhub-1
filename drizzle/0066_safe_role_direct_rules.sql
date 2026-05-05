CREATE TABLE "safe_role_direct_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_address" text,
	"token_symbol" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"counterparty" text NOT NULL,
	"amount_human" text NOT NULL,
	"period_seconds" integer NOT NULL,
	"status" text DEFAULT 'allowed' NOT NULL,
	"last_applied_tx_hash" text,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "safe_role_direct_rules" ADD CONSTRAINT "safe_role_direct_rules_role_id_safe_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."safe_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "safe_role_direct_rules_role_kind_token_cp_unique" ON "safe_role_direct_rules" USING btree ("role_id","kind","token_address","counterparty");--> statement-breakpoint
CREATE INDEX "idx_safe_role_direct_rules_role" ON "safe_role_direct_rules" USING btree ("role_id");