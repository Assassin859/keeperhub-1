import { createHash } from "node:crypto";

/**
 * Stable fingerprint of a workflow definition (its nodes + edges). Two
 * purposes that must agree on the same value:
 *
 * - stamped onto `workflow_executions.executed_workflow_hash` at trigger time
 *   so a run is tied to the exact definition that produced it, even after the
 *   workflow is later edited; and
 * - stored as `workflow_history.content_hash` for each saved version, so the
 *   execution's hash resolves to a stored snapshot by an indexed equality join
 *   with no snapshot duplication on the high-volume executions table.
 *
 * Object keys are sorted recursively so semantically identical definitions
 * hash identically (and a revert to a prior state reproduces its hash). Array
 * order is preserved -- node/edge ordering is part of the stored definition.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

export function hashWorkflowDefinition(nodes: unknown, edges: unknown): string {
  const canonical = JSON.stringify(canonicalize({ nodes, edges }));
  return createHash("sha256").update(canonical).digest("hex");
}
