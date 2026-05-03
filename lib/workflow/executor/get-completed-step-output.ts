import "server-only";

/**
 * Kill-switch: set KH_EXECUTOR_AUTHORITY_DB_FALLBACK=false to disable DB-backed
 * step authority and revert to tracker-only behaviour. Use as an ops emergency
 * rollback if DB-fallback misbehaves in production.
 *
 * Default: true (DB fallback enabled).
 */
const DB_FALLBACK_ENABLED =
  process.env.KH_EXECUTOR_AUTHORITY_DB_FALLBACK !== "false";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { getSuccessfulSteps } from "@/lib/workflow/executor/step-success-tracker";

export type CompletedStepOutput = {
  output: unknown;
  source: "tracker" | "db";
};

/**
 * Per-execution in-flight DB promise cache, keyed on `"${executionId}:${nodeId}"`.
 *
 * Multiple convergence nodes can concurrently ask for the same predecessor
 * output. This cache coalesces all concurrent callers onto a single DB query
 * for the same key within one workflow body execution. The promise is retained
 * only for the lifetime of the first caller; subsequent callers within the same
 * microtask checkpoint await the same promise. Cleared via clearOutputCache().
 *
 * Rejection handling: if the DB query rejects, the cache key is evicted so a
 * subsequent call can retry cleanly. The rejected promise does NOT stay cached.
 */
const inflightQueries = new Map<string, Promise<CompletedStepOutput | null>>();

/**
 * Clear the output cache for an execution. Call in the finally block after
 * a workflow body completes (same lifecycle as clearExecution in step-success-tracker).
 */
export function clearOutputCache(executionId: string): void {
  const prefix = `${executionId}:`;
  for (const key of inflightQueries.keys()) {
    if (key.startsWith(prefix)) {
      inflightQueries.delete(key);
    }
  }
}

/**
 * Query `workflow_execution_logs` for a single (executionId, nodeId) success row.
 *
 * Reads `output_raw` (the unredacted executor payload) rather than `output`
 * (which contains redactSensitiveData() substitutions). This ensures downstream
 * template rendering receives real values, not "[REDACTED]" strings, on
 * cross-process / cross-pod resumes.
 *
 * Filters iterationIndex IS NULL to select only canonical convergence rows, not
 * per-iteration rows from for-each loop bodies. This helper is NOT safe to call
 * for nodes inside a for-each body — callers must use a different scoping
 * (e.g. pass iterationIndex explicitly) if that use-case is ever added.
 *
 * orderBy completedAt DESC as defense-in-depth in case multiple canonical rows
 * ever exist for the same (executionId, nodeId) with status='success'.
 */
async function queryDb(
  executionId: string,
  nodeId: string
): Promise<CompletedStepOutput | null> {
  const row = await db.query.workflowExecutionLogs.findFirst({
    where: and(
      eq(workflowExecutionLogs.executionId, executionId),
      eq(workflowExecutionLogs.nodeId, nodeId),
      eq(workflowExecutionLogs.status, "success"),
      isNull(workflowExecutionLogs.iterationIndex),
      isNull(workflowExecutionLogs.forEachNodeId)
    ),
    orderBy: desc(workflowExecutionLogs.completedAt),
    columns: { outputRaw: true },
  });

  if (!row) {
    return null;
  }

  return { output: row.outputRaw as unknown, source: "db" };
}

/**
 * Resolve the latest completed output for a step, consulting the in-process
 * tracker first (fast path, no I/O) and falling back to workflow_execution_logs
 * on a tracker miss (cross-process resume path).
 *
 * Returns null when neither source has a success record -- the step has not
 * yet completed or was never recorded.
 *
 * Single-flight guarantee: multiple concurrent calls for the same
 * (executionId, nodeId) within one workflow body execution share a single
 * DB query.
 *
 * Error containment: if the DB query rejects, the cache key is evicted, a
 * structured warning is logged, a counter is incremented, and null is returned.
 * The caller falls back to the closure value. Rejection cannot poison subsequent
 * calls for the same key.
 *
 * Kill-switch: when KH_EXECUTOR_AUTHORITY_DB_FALLBACK=false the DB read is
 * skipped entirely and null is returned on a tracker miss (pre-fix behaviour).
 */
export function getCompletedStepOutput(
  executionId: string,
  nodeId: string
): Promise<CompletedStepOutput | null> {
  const trackerSteps = getSuccessfulSteps(executionId);
  if (trackerSteps?.has(nodeId)) {
    return Promise.resolve({
      output: trackerSteps.get(nodeId),
      source: "tracker" as const,
    });
  }

  if (!DB_FALLBACK_ENABLED) {
    return Promise.resolve(null);
  }

  const cacheKey = `${executionId}:${nodeId}`;
  const inflight = inflightQueries.get(cacheKey);
  if (inflight !== undefined) {
    return inflight;
  }

  const query = queryDb(executionId, nodeId).then(
    (result) => {
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        {
          source: "single",
          outcome: result === null ? "miss" : "hit",
        }
      );
      return result;
    },
    (err: unknown) => {
      inflightQueries.delete(cacheKey);
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[getCompletedStepOutput] DB fallback query failed; returning null",
        err instanceof Error ? err : new Error(String(err)),
        {
          execution_id: executionId,
          node_id: nodeId,
          db_error_class:
            err instanceof Error ? err.constructor.name : "unknown",
        }
      );
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        { source: "single", outcome: "error" }
      );
      return null;
    }
  );

  inflightQueries.set(cacheKey, query);
  return query;
}

/**
 * Batch variant of getCompletedStepOutput for fan-in convergence.
 *
 * Issues a single WHERE execution_id = $1 AND node_id = ANY($2) AND status =
 * 'success' query for all nodeIds that are not already in the tracker. Returns
 * a Map<nodeId, CompletedStepOutput> containing only nodes for which a DB row
 * was found. Tracker hits are resolved before the DB query and merged in.
 *
 * Same kill-switch, error containment, and iteration-row exclusion semantics as
 * getCompletedStepOutput. This is the preferred path for mergeFromAuthority to
 * reduce sequential DB round-trips on cold-pod 9-fan-in convergence.
 */
export async function getCompletedStepOutputs(
  executionId: string,
  nodeIds: readonly string[]
): Promise<Map<string, CompletedStepOutput>> {
  const result = new Map<string, CompletedStepOutput>();
  if (nodeIds.length === 0) {
    return result;
  }

  const trackerSteps = getSuccessfulSteps(executionId);

  const dbNodeIds: string[] = [];
  for (const nodeId of nodeIds) {
    if (trackerSteps?.has(nodeId)) {
      result.set(nodeId, {
        output: trackerSteps.get(nodeId),
        source: "tracker",
      });
    } else {
      dbNodeIds.push(nodeId);
    }
  }

  if (dbNodeIds.length === 0 || !DB_FALLBACK_ENABLED) {
    return result;
  }

  const startMs = Date.now();
  try {
    const rows = await db.query.workflowExecutionLogs.findMany({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        inArray(workflowExecutionLogs.nodeId, dbNodeIds),
        eq(workflowExecutionLogs.status, "success"),
        isNull(workflowExecutionLogs.iterationIndex),
        isNull(workflowExecutionLogs.forEachNodeId)
      ),
      orderBy: desc(workflowExecutionLogs.completedAt),
      columns: { nodeId: true, outputRaw: true },
    });

    getMetricsCollector().recordLatency(
      "workflow.executor.tracker_db_fallback.duration_ms",
      Date.now() - startMs
    );

    for (const row of rows) {
      if (!result.has(row.nodeId)) {
        result.set(row.nodeId, {
          output: row.outputRaw as unknown,
          source: "db",
        });
      }
    }

    const hitCount = rows.length;
    const missCount = dbNodeIds.length - hitCount;
    if (hitCount > 0) {
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        { source: "convergence", outcome: "hit" },
        hitCount
      );
    }
    if (missCount > 0) {
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        { source: "convergence", outcome: "miss" },
        missCount
      );
    }
  } catch (err: unknown) {
    getMetricsCollector().incrementCounter(
      "workflow.executor.tracker_db_fallback.total",
      { source: "convergence", outcome: "error" }
    );
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[getCompletedStepOutputs] Batch DB fallback query failed; returning partial tracker results",
      err instanceof Error ? err : new Error(String(err)),
      {
        execution_id: executionId,
        predecessor_count: String(nodeIds.length),
        db_error_class: err instanceof Error ? err.constructor.name : "unknown",
      }
    );
  }

  return result;
}
