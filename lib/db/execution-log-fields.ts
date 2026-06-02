import { sql } from "drizzle-orm";
import { workflowExecutionLogs } from "@/lib/db/schema";

/**
 * Shared SQL builders for extracting a field from the double-encoded JSONB
 * columns on workflow_execution_logs.
 *
 * The `output` / `input` columns are double-encoded: Drizzle stores a JSON
 * string value inside JSONB (jsonb_typeof = 'string') rather than a JSONB
 * object. To read a nested key we first unwrap the string with `#>> '{}'`,
 * re-parse as jsonb, then extract. The ELSE branch handles any rows already
 * stored as a plain object.
 *
 * This expression is the source of truth for `gasUsed` / `network` extraction
 * and MUST stay identical across every reader so they agree value-for-value:
 *   - lib/analytics/queries.ts        - the /analytics read paths
 *   - lib/workflow/executor/logging.ts - writes the denormalised run-total
 *   - scripts/backfill-workflow-gas.ts - backfills historical rows
 * Keep it in one place precisely because the three must never drift.
 */
export function logOutputField(field: string): ReturnType<typeof sql> {
  return sql`CASE
    WHEN jsonb_typeof(${workflowExecutionLogs.output}) = 'string'
    THEN (${workflowExecutionLogs.output} #>> '{}')::jsonb->>${sql.raw(`'${field}'`)}
    ELSE ${workflowExecutionLogs.output}->>${sql.raw(`'${field}'`)}
  END`;
}

export function logInputField(field: string): ReturnType<typeof sql> {
  return sql`CASE
    WHEN jsonb_typeof(${workflowExecutionLogs.input}) = 'string'
    THEN (${workflowExecutionLogs.input} #>> '{}')::jsonb->>${sql.raw(`'${field}'`)}
    ELSE ${workflowExecutionLogs.input}->>${sql.raw(`'${field}'`)}
  END`;
}
