import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs } from "@/lib/db/schema";
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

async function queryDb(
  executionId: string,
  nodeId: string
): Promise<CompletedStepOutput | null> {
  const row = await db.query.workflowExecutionLogs.findFirst({
    where: and(
      eq(workflowExecutionLogs.executionId, executionId),
      eq(workflowExecutionLogs.nodeId, nodeId),
      eq(workflowExecutionLogs.status, "success")
    ),
    columns: { output: true },
  });

  if (!row) {
    return null;
  }

  return { output: row.output as unknown, source: "db" };
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

  const cacheKey = `${executionId}:${nodeId}`;
  const inflight = inflightQueries.get(cacheKey);
  if (inflight !== undefined) {
    return inflight;
  }

  const query = queryDb(executionId, nodeId);
  inflightQueries.set(cacheKey, query);
  return query;
}
