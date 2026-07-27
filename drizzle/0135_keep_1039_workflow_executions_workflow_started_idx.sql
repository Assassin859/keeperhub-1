-- @requires-db-prep
-- Covering index for the monthly billing count over workflow_executions
-- (workflow_id join key, started_at range, billable filter all in the key),
-- so the per-message execution-limit guard resolves as an index-only scan
-- instead of heap fetches across the whole table. The (workflow_id,
-- started_at) prefix also serves the analytics org+window aggregations.
-- On large environments apply out-of-band as
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS (see the @requires-db-prep
-- runbook); this transaction-safe form then no-ops on deploy.
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_workflow_started" ON "workflow_executions" ("workflow_id", "started_at", "billable");
