CREATE TABLE "safe_module_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"safe_wallet_id" text NOT NULL,
	"module_type" text NOT NULL,
	"module_address" text NOT NULL,
	"installed_tx_hash" text,
	"installed_at" timestamp,
	"status" text DEFAULT 'enabled' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_token_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"safe_wallet_id" text NOT NULL,
	"module_type" text DEFAULT 'allowance' NOT NULL,
	"delegate_address" text NOT NULL,
	"token_address" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"amount_wei" text NOT NULL,
	"period_minutes" integer NOT NULL,
	"reset_at" timestamp,
	"last_tx_hash" text,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"safe_address" text NOT NULL,
	"owner_wallet_id" text,
	"owners" jsonb NOT NULL,
	"threshold" integer NOT NULL,
	"salt_nonce" text NOT NULL,
	"safe_version" text DEFAULT '1.4.1' NOT NULL,
	"singleton_address" text NOT NULL,
	"factory_address" text NOT NULL,
	"deployment_tx_hash" text,
	"deployment_block" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"deployed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "safe_module_installations" ADD CONSTRAINT "safe_module_installations_safe_wallet_id_safe_wallets_id_fk" FOREIGN KEY ("safe_wallet_id") REFERENCES "public"."safe_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_token_limits" ADD CONSTRAINT "safe_token_limits_safe_wallet_id_safe_wallets_id_fk" FOREIGN KEY ("safe_wallet_id") REFERENCES "public"."safe_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_wallets" ADD CONSTRAINT "safe_wallets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_wallets" ADD CONSTRAINT "safe_wallets_owner_wallet_id_para_wallets_id_fk" FOREIGN KEY ("owner_wallet_id") REFERENCES "public"."para_wallets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "safe_module_inst_safe_type_unique" ON "safe_module_installations" USING btree ("safe_wallet_id","module_type");--> statement-breakpoint
CREATE INDEX "idx_safe_module_inst_safe" ON "safe_module_installations" USING btree ("safe_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_token_limits_safe_delegate_token_unique" ON "safe_token_limits" USING btree ("safe_wallet_id","delegate_address","token_address");--> statement-breakpoint
CREATE INDEX "idx_safe_token_limits_safe" ON "safe_token_limits" USING btree ("safe_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_wallets_org_chain_unique" ON "safe_wallets" USING btree ("organization_id","chain_id");--> statement-breakpoint
CREATE INDEX "idx_safe_wallets_org" ON "safe_wallets" USING btree ("organization_id");