/**
 * KEEP-1541: In-memory tracker for step successes within a workflow execution.
 *
 * Both withStepLogging (step-handler.ts) and the workflow executor run in the
 * same Node.js process, so a module-level Map is sufficient. This replaces the
 * HTTP loopback approach that failed silently in production.
 *
 * Only successes are tracked. The reconciler treats a tracked success as proof
 * that the step completed, regardless of subsequent SDK retry errors. This is
 * safe because withStepLogging records success only after the step function
 * returns without error -- the "max retries exceeded" error originates from
 * the SDK's durability layer, not from the step itself.
 *
 * Lifecycle:
 *   1. withStepLogging calls recordStepSuccess() after each successful step
 *   2. The executor calls getSuccessfulSteps() during max-retries reconciliation
 *   3. The executor calls clearExecution() in a finally block to free memory
 */

const executions = new Map<string, Map<string, unknown>>();

export function recordStepSuccess(
  executionId: string,
  nodeId: string,
  output: unknown
): void {
  let steps = executions.get(executionId);
  if (steps === undefined) {
    steps = new Map<string, unknown>();
    executions.set(executionId, steps);
  }
  steps.set(nodeId, output);
}

export function getSuccessfulSteps(
  executionId: string
): Map<string, unknown> | undefined {
  return executions.get(executionId);
}

export function clearExecution(executionId: string): void {
  executions.delete(executionId);
}
