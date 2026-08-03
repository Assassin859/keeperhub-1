import {
  extractActionTypeNodes,
  validateWorkflowFeatures,
} from "./workflow-validator";

/**
 * Returns true when a workflow uses features gated behind Pro (or higher) on
 * the free plan. Used by the public marketplace feed to surface plan badges
 * before a user duplicates a template.
 */
export function workflowRequiresProPlan(nodes: readonly unknown[]): boolean {
  return (
    validateWorkflowFeatures(extractActionTypeNodes(nodes), "free").length > 0
  );
}
