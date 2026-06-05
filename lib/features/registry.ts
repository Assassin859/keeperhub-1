// Single source of truth for gated features. Adding a new gated feature
// is a one-entry diff here. The validator, server guard, and UI all read
// from this registry.

import type { FeatureDefinition, FeatureId } from "./types";

export const FEATURES: Record<FeatureId, FeatureDefinition> = {
  "action.database-query": {
    id: "action.database-query",
    name: "Database Query action",
    description:
      "Run SQL queries against connected databases inside workflows.",
    category: "workflow-action",
    enabled: true,
    requiredPlan: "pro",
    actionTypes: ["Database Query"],
  },
  "action.http-request": {
    id: "action.http-request",
    name: "HTTP Request action",
    description:
      "Call any external API from a workflow with full control over method, headers, and body.",
    category: "workflow-action",
    enabled: true,
    requiredPlan: "pro",
    actionTypes: ["HTTP Request"],
  },
  "action.code": {
    id: "action.code",
    name: "Code action",
    description:
      "Execute custom JavaScript in a sandboxed environment with access to upstream node outputs.",
    category: "workflow-action",
    enabled: true,
    requiredPlan: "pro",
    actionTypes: ["code/run-code"],
  },
  "action.webhook": {
    id: "action.webhook",
    name: "Send Webhook action",
    description:
      "Send HTTP requests to webhook endpoints with custom method, headers, and payload.",
    category: "workflow-action",
    enabled: true,
    requiredPlan: "pro",
    actionTypes: ["webhook/send-webhook"],
  },
  "notifications.failure-digest": {
    id: "notifications.failure-digest",
    name: "Execution digest",
    description:
      "Email subscribed org members a daily or weekly summary of workflow executions: total runs, successes, and failures.",
    category: "observability",
    enabled: true,
    requiredPlan: "pro",
    upgradeCta:
      "Upgrade to get scheduled email digests of your workflow executions.",
  },
} as const;

// Pre-computed reverse index: actionType -> FeatureId. Built once at module
// load. Used by the workflow validator and the UI to look up gating info
// without scanning the registry on every node.
const ACTION_TYPE_TO_FEATURE_ID: ReadonlyMap<string, FeatureId> = (() => {
  const map = new Map<string, FeatureId>();
  for (const feature of Object.values(FEATURES)) {
    if (!feature.actionTypes) {
      continue;
    }
    for (const actionType of feature.actionTypes) {
      map.set(actionType, feature.id);
    }
  }
  return map;
})();

export function getFeature(featureId: FeatureId): FeatureDefinition {
  return FEATURES[featureId];
}

export function getFeatureForActionType(
  actionType: string
): FeatureDefinition | undefined {
  const featureId = ACTION_TYPE_TO_FEATURE_ID.get(actionType);
  return featureId ? FEATURES[featureId] : undefined;
}

export function getAllFeatures(): readonly FeatureDefinition[] {
  return Object.values(FEATURES);
}

export function getFeaturesByCategory(
  category: FeatureDefinition["category"]
): readonly FeatureDefinition[] {
  return Object.values(FEATURES).filter((f) => f.category === category);
}
