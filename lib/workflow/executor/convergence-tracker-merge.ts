/**
 * KEEP-395: Convergence template race -- the closure-captured outputs map can
 * be stale at template-render time for the LAST predecessor of a fan-in
 * convergence node when the workflow is replayed/rehydrated under
 * "use workflow" durability. The mutation of `outputs[<id>] = ...` happens
 * after the awaited step return, so the SDK's checkpoint resume can see a
 * snapshot where one predecessor's output is still null even though the
 * step completed successfully and recordStepSuccess was called.
 *
 * `mergeFromTracker` (synchronous, in-process tracker only) is retained for
 * existing callers and unit tests.
 *
 * `mergeFromAuthority` (async, tracker + DB fallback) is the durable
 * replacement. It consults the in-process tracker first (fast path, zero I/O)
 * and falls back to `workflow_execution_logs` for any predecessor missing from
 * the tracker -- which happens on cross-process / cross-pod SDK resumes where
 * the predecessor steps ran on a different worker.
 *
 * This helper is split into a separate module so it can be unit-tested in
 * isolation without spinning up the full workflow executor.
 */

import { getCompletedStepOutput } from "@/lib/workflow/executor/get-completed-step-output";
import type { WorkflowNode } from "@/lib/workflow/store";

export type NodeOutputs = Record<string, { label: string; data: unknown }>;

type TrackerLookup = (executionId: string) => Map<string, unknown> | undefined;
type NodeNameLookup = (node: WorkflowNode) => string;

/**
 * Merge tracker-recorded outputs over the closure outputs map for the
 * predecessors of a convergence node.
 *
 * Returns the original outputs map unchanged when:
 *   - no executionId is provided
 *   - the tracker has no entries for this execution
 *   - none of the predecessors have tracker entries
 *
 * Otherwise returns a fresh shallow-copied outputs map with the tracker
 * entries merged in. The tracker value wins -- if the closure already has a
 * value for a predecessor, the tracker entry overrides it.
 */
export function mergeFromTracker(params: {
  outputs: NodeOutputs;
  executionId: string | undefined;
  predecessorIds: readonly string[];
  nodeMap: ReadonlyMap<string, WorkflowNode>;
  getTracker: TrackerLookup;
  getNodeName: NodeNameLookup;
}): NodeOutputs {
  const {
    outputs,
    executionId,
    predecessorIds,
    nodeMap,
    getTracker,
    getNodeName,
  } = params;

  if (!executionId || predecessorIds.length === 0) {
    return outputs;
  }

  const recorded = getTracker(executionId);
  if (recorded === undefined || recorded.size === 0) {
    return outputs;
  }

  let merged: NodeOutputs | null = null;

  for (const predId of predecessorIds) {
    if (!recorded.has(predId)) {
      continue;
    }
    const node = nodeMap.get(predId);
    if (!node) {
      continue;
    }
    if (merged === null) {
      merged = { ...outputs };
    }
    const sanitized = predId.replace(/[^a-zA-Z0-9]/g, "_");
    merged[sanitized] = {
      label: getNodeName(node),
      data: recorded.get(predId),
    };
  }

  return merged ?? outputs;
}

/**
 * Authoritative async replacement for `mergeFromTracker`.
 *
 * For every direct predecessor, checks the in-process tracker first. For any
 * predecessor missing from the tracker (cross-process / cross-pod resume),
 * queries `workflow_execution_logs` for the latest success row and merges that
 * output over the closure map.
 *
 * When both tracker and DB miss for a predecessor, the existing closure value
 * is left unchanged (the step genuinely has not completed yet, or was never
 * recorded).
 *
 * Returns the original outputs map (identity) when no merge is needed.
 */
export async function mergeFromAuthority(params: {
  outputs: NodeOutputs;
  executionId: string | undefined;
  predecessorIds: readonly string[];
  nodeMap: ReadonlyMap<string, WorkflowNode>;
  getNodeName: NodeNameLookup;
}): Promise<NodeOutputs> {
  const { outputs, executionId, predecessorIds, nodeMap, getNodeName } = params;

  if (!executionId || predecessorIds.length === 0) {
    return outputs;
  }

  let merged: NodeOutputs | null = null;

  for (const predId of predecessorIds) {
    const node = nodeMap.get(predId);
    if (!node) {
      continue;
    }

    const result = await getCompletedStepOutput(executionId, predId);
    if (result === null) {
      continue;
    }

    if (merged === null) {
      merged = { ...outputs };
    }
    const sanitized = predId.replace(/[^a-zA-Z0-9]/g, "_");
    merged[sanitized] = {
      label: getNodeName(node),
      data: result.output,
    };
  }

  return merged ?? outputs;
}
