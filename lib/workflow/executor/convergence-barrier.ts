/**
 * Pure convergence barrier logic for fork-join synchronization in
 * workflow execution. Extracted so the algorithms can be tested
 * directly without mocking the full executor.
 */

type EdgeLike = {
  source: string;
  target: string;
};

/** Build reverse edge map: target node ID -> source node IDs. */
export function buildEdgesByTarget(edges: EdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = map.get(edge.target) ?? [];
    if (!sources.includes(edge.source)) {
      sources.push(edge.source);
    }
    map.set(edge.target, sources);
  }
  return map;
}

/** Build forward edge map: source node ID -> target node IDs. */
export function buildEdgesBySource(edges: EdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = map.get(edge.source) ?? [];
    if (!targets.includes(edge.target)) {
      targets.push(edge.target);
    }
    map.set(edge.source, targets);
  }
  return map;
}

/**
 * Signal arrival at convergence nodes (nodes with >1 incoming edge) and
 * return the IDs of any that became fully unblocked. Non-convergence nodes
 * in targetNodeIds are ignored.
 */
export function signalConvergenceArrival(
  fromNodeId: string,
  targetNodeIds: string[],
  edgesByTarget: Map<string, string[]>,
  convergenceArrivals: Map<string, Set<string>>,
  visited: Set<string>
): string[] {
  const unblocked: string[] = [];
  for (const nextId of targetNodeIds) {
    const incomingSources = edgesByTarget.get(nextId);
    if (incomingSources === undefined || incomingSources.length <= 1) {
      continue;
    }
    let arrivals = convergenceArrivals.get(nextId);
    if (arrivals === undefined) {
      arrivals = new Set<string>();
      convergenceArrivals.set(nextId, arrivals);
    }
    arrivals.add(fromNodeId);
    if (arrivals.size >= incomingSources.length && !visited.has(nextId)) {
      unblocked.push(nextId);
    }
  }
  return unblocked;
}

/**
 * Determine which downstream nodes are ready to execute, applying
 * convergence barriers for nodes with multiple incoming edges.
 * Non-convergence nodes pass through immediately.
 */
export function getReadyDownstreamIds(
  fromNodeId: string,
  nextNodeIds: string[],
  edgesByTarget: Map<string, string[]>,
  convergenceArrivals: Map<string, Set<string>>,
  visited: Set<string>
): string[] {
  const readyIds: string[] = [];

  for (const nextId of nextNodeIds) {
    const incomingSources = edgesByTarget.get(nextId);
    const isConvergenceNode =
      incomingSources !== undefined && incomingSources.length > 1;

    if (!isConvergenceNode) {
      readyIds.push(nextId);
    }
  }

  readyIds.push(
    ...signalConvergenceArrival(
      fromNodeId,
      nextNodeIds,
      edgesByTarget,
      convergenceArrivals,
      visited
    )
  );

  return readyIds;
}

/**
 * Propagate skip signals through branches that were not taken by a condition.
 * BFS through the skipped subtree, signaling arrival at convergence nodes.
 * Returns convergence node IDs that became fully unblocked (caller handles
 * execution).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: BFS with convergence detection requires nested branching
export function propagateConvergenceSkips(
  skippedNodeIds: string[],
  edgesBySource: Map<string, string[]>,
  edgesByTarget: Map<string, string[]>,
  convergenceArrivals: Map<string, Set<string>>,
  visited: Set<string>
): string[] {
  const unblocked: string[] = [];
  const queue = [...skippedNodeIds];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    if (seen.has(currentId)) {
      continue;
    }
    seen.add(currentId);

    const incomingSources = edgesByTarget.get(currentId);
    const isConvergenceNode =
      incomingSources !== undefined && incomingSources.length > 1;

    if (isConvergenceNode) {
      for (const src of incomingSources) {
        if (seen.has(src) || skippedNodeIds.includes(src)) {
          let arrivals = convergenceArrivals.get(currentId);
          if (arrivals === undefined) {
            arrivals = new Set<string>();
            convergenceArrivals.set(currentId, arrivals);
          }
          arrivals.add(src);
        }
      }

      if (
        (convergenceArrivals.get(currentId)?.size ?? 0) >=
        incomingSources.length
      ) {
        // Check if any arrival came from a real (non-skip) execution.
        // If all arrivals are from the skipped subtree, this node should
        // also be skipped -- continue BFS instead of executing it.
        const allFromSkipped = incomingSources.every(
          (src) => seen.has(src) || skippedNodeIds.includes(src)
        );
        if (allFromSkipped) {
          // Continue propagating skip through this convergence node
          const downstream = edgesBySource.get(currentId) ?? [];
          for (const downId of downstream) {
            if (!seen.has(downId)) {
              queue.push(downId);
            }
          }
          continue;
        }
        if (!visited.has(currentId)) {
          unblocked.push(currentId);
        }
        continue;
      }
      // Convergence node not fully resolved: stop BFS here. It is still
      // awaiting arrivals from the real execution path and should not
      // propagate skip signals to its downstream.
      continue;
    }

    const downstream = edgesBySource.get(currentId) ?? [];
    for (const downId of downstream) {
      if (!seen.has(downId)) {
        queue.push(downId);
      }
    }
  }

  return unblocked;
}
