DROP INDEX "safe_role_allowances_role_token_unique";--> statement-breakpoint
-- Greenfield migration: per-(protocol, token) allowance keys reshape every
-- row's allowanceKey, so any existing pre-protocol-aware rows are unsafe to
-- keep. Plan KEEP-177 explicitly authorises dropping dev/staging data; no
-- production rows exist yet.
DELETE FROM "safe_role_allowances";--> statement-breakpoint
ALTER TABLE "safe_role_allowances" ADD COLUMN "protocol_slug" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "safe_role_allowances_role_protocol_token_unique" ON "safe_role_allowances" USING btree ("role_id","protocol_slug","token_address");