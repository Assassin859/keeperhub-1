// Recurrence backstop for the egress-gating fix.
//
// These invariants make "a new network-egress action ships ungated" a build
// failure rather than a production incident. They enumerate the real dispatch
// universe (every registered plugin action plus the built-in system actions)
// and assert that (a) every action is classified, (b) every action the user can
// point at a destination of their choosing is plan-gated, and (c) any plugin
// that exposes a user-supplied connection URL is classified accordingly.
//
// Requires the plugin registry to be loaded (and `pnpm discover-plugins` to
// have generated the protocol barrel), so this is intentionally not a pure
// unit test.

import { describe, expect, it } from "vitest";

import {
  getActionEgress,
  isFeatureEnabled,
  resolveActionFeature,
} from "@/lib/features";
import { SYSTEM_ACTION_EGRESS } from "@/lib/features/system-action-capabilities";
import { getAllActions, getAllIntegrations } from "@/plugins/registry";

// Mirrors the keys of SYSTEM_ACTIONS in lib/workflow/executor/executor.workflow.ts.
// If a built-in action is added there, it must be classified in
// SYSTEM_ACTION_EGRESS too - this list is the drift guard.
const EXPECTED_SYSTEM_ACTIONS = [
  "Collect",
  "Condition",
  "Database Query",
  "For Each",
  "HTTP Request",
];

describe("egress classification completeness", () => {
  it("classifies every registered plugin action (no unknowns)", () => {
    const unclassified = getAllActions()
      .filter((action) => getActionEgress(action.id) === "unknown")
      .map((action) => action.id);

    expect(unclassified).toEqual([]);
  });

  it("keeps the system-action capability map in sync with the executor", () => {
    expect(Object.keys(SYSTEM_ACTION_EGRESS).sort()).toEqual(
      EXPECTED_SYSTEM_ACTIONS
    );
  });
});

describe("user-destination actions are plan gated", () => {
  it("gates every user-destination plugin action for the free plan", () => {
    const ungated = getAllActions()
      .filter((action) => getActionEgress(action.id) === "user-destination")
      .filter((action) => {
        const feature = resolveActionFeature(action.id);
        return !feature || isFeatureEnabled(feature.id, "free");
      })
      .map((action) => action.id);

    expect(ungated).toEqual([]);
  });

  it("gates every user-destination system action for the free plan", () => {
    for (const [actionType, tier] of Object.entries(SYSTEM_ACTION_EGRESS)) {
      if (tier !== "user-destination") {
        continue;
      }
      const feature = resolveActionFeature(actionType);
      expect(feature).toBeDefined();
      if (!feature) {
        continue;
      }
      expect(isFeatureEnabled(feature.id, "free")).toBe(false);
    }
  });
});

describe("connection URL surfaces are classified", () => {
  it("classifies every plugin that exposes a user-supplied connection URL as user-destination", () => {
    const misclassified = getAllIntegrations()
      .filter((plugin) =>
        plugin.formFields.some((field) => field.type === "url")
      )
      .filter((plugin) => plugin.egress !== "user-destination")
      .map((plugin) => plugin.type);

    expect(misclassified).toEqual([]);
  });
});

describe("known fixtures", () => {
  it("classifies blockscout as user-destination and gates it for free", () => {
    expect(getActionEgress("blockscout/get-address-balance")).toBe(
      "user-destination"
    );
    const feature = resolveActionFeature("blockscout/get-address-balance");
    expect(feature?.id).toBe("action.external-request");
    expect(isFeatureEnabled("action.external-request", "free")).toBe(false);
    expect(isFeatureEnabled("action.external-request", "pro")).toBe(true);
  });
});
