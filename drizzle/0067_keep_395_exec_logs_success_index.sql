-- KEEP-395: partial composite index on workflow_execution_logs for executor
-- authority lookups.
--
-- The getCompletedStepOutput helper queries:
--   WHERE execution_id = $1 AND node_id = $2 AND status = 'success'
--
-- The existing idx_exec_logs_execution_id covers only (execution_id). Adding a
-- covering index on (execution_id, node_id) filtered to status='success' rows
-- eliminates heap rechecks for this specific hot read path. The partial filter
-- keeps the index small relative to the total table (~1/N of rows for an
-- N-status log table).
--
-- CONCURRENTLY is required because this table receives continuous writes during
-- workflow execution. A non-concurrent build would take a write lock, stalling
-- all step completions for the duration of the index build on deploy.
-- Drizzle does not support CONCURRENTLY natively so this migration is written
-- as raw SQL.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exec_logs_success_lookup
  ON workflow_execution_logs (execution_id, node_id)
  WHERE status = 'success';
