// Validates a workflow's nodes against the feature registry given a plan.
// Used at save time (reject if violations) and at execute time (hard block).

import type { PlanName } from "@/lib/billing/plans";
import { isFeatureEnabled } from "./check";
import { getFeatureForActionType } from "./registry";
import type {
  FeatureId,
  WorkflowFeatureViolation,
  WorkflowNodeRef,
} from "./types";

export function validateWorkflowFeatures(
  nodes: readonly WorkflowNodeRef[],
  plan: PlanName
): WorkflowFeatureViolation[] {
  const violations = new Map<FeatureId, WorkflowFeatureViolation>();

  for (const node of nodes) {
    const feature = getFeatureForActionType(node.actionType);
    if (!feature) {
      continue;
    }
    if (isFeatureEnabled(feature.id, plan)) {
      continue;
    }

    const existing = violations.get(feature.id);
    if (existing) {
      existing.nodeIds.push(node.id);
      continue;
    }
    violations.set(feature.id, {
      featureId: feature.id,
      feature,
      actionType: node.actionType,
      nodeIds: [node.id],
    });
  }

  return [...violations.values()];
}

// Helper to extract the bits the validator needs from a raw workflow JSONB
// payload. Nodes live in `workflow.nodes` as a JSONB array; each node carries
// `data.config.actionType` (set by the action grid when the action is picked).
// Tolerant of unknown shapes — unknown nodes are simply ignored.
type UnknownNode = {
  id?: unknown;
  data?: { config?: { actionType?: unknown } };
};

export function extractActionTypeNodes(
  nodes: readonly unknown[]
): WorkflowNodeRef[] {
  const refs: WorkflowNodeRef[] = [];
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const node = raw as UnknownNode;
    const id = typeof node.id === "string" ? node.id : null;
    const actionType = node.data?.config?.actionType;
    if (!id || typeof actionType !== "string") {
      continue;
    }
    refs.push({ id, actionType });
  }
  return refs;
}
