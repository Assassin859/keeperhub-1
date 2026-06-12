import { describe, expect, it } from "vitest";
import { describeAuditAction } from "@/lib/security/audit-actions";

describe("describeAuditAction", () => {
  it("maps known actions to a phrase and kind", () => {
    expect(describeAuditAction("api_key.created")).toEqual({
      phrase: "created an API key",
      kind: "add",
    });
    expect(describeAuditAction("workflow.deleted").kind).toBe("remove");
    expect(describeAuditAction("subscription.plan_changed").kind).toBe(
      "change"
    );
  });

  it("maps integration actions", () => {
    expect(describeAuditAction("integration.created")).toEqual({
      phrase: "added an integration",
      kind: "add",
    });
    expect(describeAuditAction("integration.updated").kind).toBe("change");
    expect(describeAuditAction("integration.deleted").kind).toBe("remove");
  });

  it("humanizes an unknown action as a change", () => {
    expect(describeAuditAction("widget.frobnicated")).toEqual({
      phrase: "widget frobnicated",
      kind: "change",
    });
  });
});
