-- KEEP-683: denormalise run-total gas and network onto workflow_executions.
--
-- The /analytics summary and spend-cap reads currently total gas by extracting
-- `gasUsed` from the per-step workflow_execution_logs.output JSONB and SUM-ing
-- it across the org+window slice. That expression is unindexable, so the query
-- full-scans workflow_executions and probes every org log row, detoasting each
-- output blob - the cost behind the 2026-05-29 RDS saturation.
--
-- These two columns let those reads aggregate a first-class numeric column on a
-- table already in the query, with no logs join and no JSONB parse. They are
-- populated at the status='success' finalize, alongside transaction_hashes
-- (lib/workflow/executor/logging.ts), and backfilled for historical rows by a
-- separate batched operator script (scripts/backfill-workflow-gas.ts).
--
-- No `-- @requires-db-prep` directive: ADD COLUMN of a nullable column with no
-- default is a catalog-only change in PostgreSQL 11+ (momentary ACCESS
-- EXCLUSIVE lock, no table rewrite), so it is safe to run inline via the normal
-- drizzle-kit migrate path even on the multi-GB prod table. The heavy work is
-- the backfill UPDATE, which is intentionally NOT in this migration - it runs
-- out-of-band, batched, after deploy.

ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "gas_used_wei" numeric;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "network" text;
