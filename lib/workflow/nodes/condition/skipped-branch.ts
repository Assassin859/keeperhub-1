/**
 * Utilities for tracking condition routing decisions and identifying
 * nodes on dead (not-taken) branches during workflow execution.
 */

import type { EdgesBySourceHandle } from "@/lib/edge-handle-utils";

export type ConditionDecision = {
  taken: string;
  skippedTargets: string[];
};

/**
 * Given a condition node and the handle that was NOT taken,
 * return the direct target node IDs on that handle.
 */
export function collectSkippedTargets(
  conditionNodeId: string,
  notTakenHandle: string,
  edgesBySourceHandle: EdgesBySourceHandle
): string[] {
  const handleMap = edgesBySourceHandle.get(conditionNodeId);
  if (!handleMap) {
    return [];
  }
  return handleMap.get(notTakenHandle) ?? [];
}

/**
 * Aggregate all skipped targets from every condition decision
 * into a single set for finalSuccess evaluation.
 */
export function collectAllSkippedTargets(
  conditionDecisions: Map<string, ConditionDecision>
): Set<string> {
  const allSkipped = new Set<string>();
  for (const decision of conditionDecisions.values()) {
    for (const target of decision.skippedTargets) {
      allSkipped.add(target);
    }
  }
  return allSkipped;
}
