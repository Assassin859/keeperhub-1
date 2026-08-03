import { describe, expect, it } from "vitest";
import { workflowRequiresProPlan } from "@/lib/features/template-plan-gate";

describe("workflowRequiresProPlan", () => {
  it("returns false for trigger + ungated actions only", () => {
    const nodes = [
      { id: "t1", data: { config: { triggerType: "Manual" } } },
      { id: "n1", data: { config: { actionType: "Condition" } } },
    ];
    expect(workflowRequiresProPlan(nodes)).toBe(false);
  });

  it("returns true for webhook/send-webhook", () => {
    const nodes = [
      { id: "n1", data: { config: { actionType: "webhook/send-webhook" } } },
    ];
    expect(workflowRequiresProPlan(nodes)).toBe(true);
  });

  it("returns true for Database Query", () => {
    const nodes = [
      { id: "n1", data: { config: { actionType: "Database Query" } } },
    ];
    expect(workflowRequiresProPlan(nodes)).toBe(true);
  });

  it("returns false for empty or malformed nodes", () => {
    expect(workflowRequiresProPlan([])).toBe(false);
    expect(workflowRequiresProPlan([null, 42, "bad"])).toBe(false);
    expect(workflowRequiresProPlan([{ id: "n1", data: { config: {} } }])).toBe(
      false
    );
  });
});
