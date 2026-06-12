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

  it("maps member lifecycle actions", () => {
    expect(describeAuditAction("member.invited").kind).toBe("add");
    expect(describeAuditAction("member.joined").kind).toBe("add");
    expect(describeAuditAction("member.left").kind).toBe("remove");
    expect(describeAuditAction("member.removed").kind).toBe("remove");
    expect(describeAuditAction("member.role_changed").kind).toBe("change");
  });

  it("maps org, project, and tag actions", () => {
    expect(describeAuditAction("org.updated").kind).toBe("change");
    expect(describeAuditAction("org.digest_settings_changed").kind).toBe(
      "change"
    );
    expect(describeAuditAction("account.reactivated").kind).toBe("add");
    expect(describeAuditAction("project.created").kind).toBe("add");
    expect(describeAuditAction("project.deleted").kind).toBe("remove");
    expect(describeAuditAction("tag.updated").kind).toBe("change");
    expect(describeAuditAction("public_tag.created").kind).toBe("add");
  });

  it("maps wallet actions", () => {
    expect(describeAuditAction("agentic_wallet.approval_granted").kind).toBe(
      "add"
    );
    expect(describeAuditAction("agentic_wallet.approval_denied").kind).toBe(
      "remove"
    );
    expect(describeAuditAction("wallet.private_key_exported").kind).toBe(
      "change"
    );
  });

  it("humanizes an unknown action as a change", () => {
    expect(describeAuditAction("widget.frobnicated")).toEqual({
      phrase: "widget frobnicated",
      kind: "change",
    });
  });
});
