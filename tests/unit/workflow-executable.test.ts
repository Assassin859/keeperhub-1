import { describe, expect, it, vi } from "vitest";

// The SQL builder references workflows/users columns; the in-memory predicate
// is pure. Mock the schema so importing the module under test does not pull a
// real db connection (executable.ts only needs the column handles for the SQL
// builder, which these tests assert returns a defined predicate).
vi.mock("@/lib/db/schema", () => ({
  workflows: { enabled: "enabled", deletedAt: "deleted_at", userId: "user_id" },
  users: { id: "id", deactivatedAt: "deactivated_at" },
}));

import {
  getWorkflowExecutability,
  workflowExecutableConditions,
  workflowReachableConditions,
} from "@/lib/workflow/executable";

describe("getWorkflowExecutability", () => {
  it("is executable when enabled, not deleted, and owner active", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: null,
        ownerDeactivatedAt: null,
      })
    ).toEqual({ executable: true });
  });

  it("reports 'deleted' when soft-deleted, even if still enabled", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: new Date(),
        ownerDeactivatedAt: null,
      })
    ).toEqual({ executable: false, reason: "deleted" });
  });

  it("prefers 'deleted' over 'disabled' when both apply", () => {
    expect(
      getWorkflowExecutability({
        enabled: false,
        deletedAt: new Date(),
        ownerDeactivatedAt: null,
      })
    ).toEqual({ executable: false, reason: "deleted" });
  });

  it("reports 'disabled' when not enabled and not deleted", () => {
    expect(
      getWorkflowExecutability({
        enabled: false,
        deletedAt: null,
        ownerDeactivatedAt: null,
      })
    ).toEqual({ executable: false, reason: "disabled" });
  });

  it("reports 'owner_deactivated' when enabled and not deleted but owner is deactivated", () => {
    expect(
      getWorkflowExecutability({
        enabled: true,
        deletedAt: null,
        ownerDeactivatedAt: new Date(),
      })
    ).toEqual({ executable: false, reason: "owner_deactivated" });
  });

  it("treats absent timestamps as not-set (trimmed shapes)", () => {
    expect(getWorkflowExecutability({ enabled: true })).toEqual({
      executable: true,
    });
  });
});

describe("workflowExecutableConditions", () => {
  it("returns a defined SQL predicate", () => {
    expect(workflowExecutableConditions()).toBeDefined();
  });

  it("returns a fresh predicate instance per call (no shared mutable state)", () => {
    expect(workflowExecutableConditions()).not.toBe(
      workflowExecutableConditions()
    );
  });
});

describe("workflowReachableConditions", () => {
  it("returns a defined SQL predicate", () => {
    expect(workflowReachableConditions()).toBeDefined();
  });

  it("returns a fresh predicate instance per call (no shared mutable state)", () => {
    expect(workflowReachableConditions()).not.toBe(
      workflowReachableConditions()
    );
  });
});
