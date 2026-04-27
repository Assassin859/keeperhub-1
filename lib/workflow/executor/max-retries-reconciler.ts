/**
 * KEEP-1541: The Workflow DevKit's "use step" durability layer can throw
 * retry-related errors even when the step itself succeeded. This happens
 * because the SDK's internal state tracking encounters a conflict (e.g.,
 * step already completed, state replay mismatch) AFTER withStepLogging has
 * already recorded a success log in workflow_execution_logs. The error is
 * caught by executeNode's catch block and stored as a failed result, which
 * then causes finalSuccess to be false -- marking the entire workflow as
 * "error" despite all steps completing successfully.
 *
 * The SDK produces two error formats:
 *   1. Pre-check path:  'Step "X" exceeded max retries (N retries)'
 *   2. Catch path:      'Step "X" failed after N retries: {error}'
 *
 * Fix: after all nodes finish, cross-reference failed results against the
 * in-memory success tracker. If a failed node has a recorded success in the
 * tracker, the SDK error was spurious and we override the result to success.
 *
 * Two reconciliation passes:
 *   1. reconcileMaxRetriesFailures - targets "exceeded max retries" errors
 *      specifically (original KEEP-1541 fix)
 *   2. reconcileSdkFailures - catches ANY remaining failed node whose step
 *      was recorded as successful by withStepLogging. This covers SDK errors
 *      that surface with different messages in branching/parallel workflows
 *      (e.g., event log corruption, unexpected event types, state replay
 *      mismatches during condition node branching).
 */

type ExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type ReconcileInput = {
  results: Record<string, ExecutionResult>;
  successfulSteps: Map<string, unknown>;
  workflowId: string | undefined;
  executionId: string | undefined;
};

type ReconcileOutput = {
  overriddenNodeIds: string[];
};

// SDK error message substrings used to identify spurious retry failures.
// The SDK produces two distinct formats depending on the code path.
// If the SDK changes this wording, update these constants.
export const MAX_RETRIES_ERROR_MARKER = "exceeded max retries";
export const FAILED_AFTER_RETRIES_MARKER = "failed after";

export function isSdkRetryError(error: string | undefined): boolean {
  if (!error) {
    return false;
  }
  return (
    error.includes(MAX_RETRIES_ERROR_MARKER) ||
    error.includes(FAILED_AFTER_RETRIES_MARKER)
  );
}

export function getFailedMaxRetriesNodeIds(
  results: Record<string, ExecutionResult>
): string[] {
  return Object.entries(results)
    .filter(([, r]) => !r.success && isSdkRetryError(r.error))
    .map(([nodeId]) => nodeId);
}

export function reconcileMaxRetriesFailures(
  input: ReconcileInput
): ReconcileOutput {
  const { results, successfulSteps, workflowId, executionId } = input;

  const failedNodeIds = getFailedMaxRetriesNodeIds(results);

  if (failedNodeIds.length === 0) {
    return { overriddenNodeIds: [] };
  }

  const overriddenNodeIds: string[] = [];

  for (const failedNodeId of failedNodeIds) {
    if (successfulSteps.has(failedNodeId)) {
      const successOutput = successfulSteps.get(failedNodeId);
      console.warn(
        "[Workflow Executor] Overriding spurious max-retries failure for node with tracked success:",
        {
          error: results[failedNodeId]?.error,
          ...(workflowId ? { workflow_id: workflowId } : {}),
          ...(executionId ? { execution_id: executionId } : {}),
          node_id: failedNodeId,
        }
      );
      results[failedNodeId] = {
        success: true,
        data: successOutput,
      };
      overriddenNodeIds.push(failedNodeId);
    }
  }

  return { overriddenNodeIds };
}

/**
 * General SDK error reconciliation: any node that failed in results but was
 * recorded as successful by withStepLogging must have encountered a post-
 * completion SDK error (state replay mismatch, event log conflict, etc.).
 * Override these to success using the tracked output.
 *
 * This runs AFTER reconcileMaxRetriesFailures to catch SDK errors with
 * different/unexpected error messages.
 */
export function reconcileSdkFailures(input: ReconcileInput): ReconcileOutput {
  const { results, successfulSteps, workflowId, executionId } = input;

  const failedNodeIds = Object.entries(results)
    .filter(([, r]) => !r.success)
    .map(([nodeId]) => nodeId);

  if (failedNodeIds.length === 0) {
    return { overriddenNodeIds: [] };
  }

  const overriddenNodeIds: string[] = [];

  for (const failedNodeId of failedNodeIds) {
    if (successfulSteps.has(failedNodeId)) {
      const successOutput = successfulSteps.get(failedNodeId);
      console.warn(
        "[Workflow Executor] Overriding SDK-induced failure for node with tracked success:",
        {
          error: results[failedNodeId]?.error,
          ...(workflowId ? { workflow_id: workflowId } : {}),
          ...(executionId ? { execution_id: executionId } : {}),
          node_id: failedNodeId,
        }
      );
      results[failedNodeId] = {
        success: true,
        data: successOutput,
      };
      overriddenNodeIds.push(failedNodeId);
    }
  }

  return { overriddenNodeIds };
}
