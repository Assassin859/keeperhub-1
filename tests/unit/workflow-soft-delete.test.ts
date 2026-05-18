import { beforeEach, describe, expect, it, vi } from "vitest";

// KEEP-440: workflows are soft-deleted (deletedAt set) instead of hard-deleted
// so the listed slug stays bound to the row and cannot be re-claimed. These
// tests cover the unit-level surface of that change: the soft-delete helpers
// and the isDeleted signal getWorkflowAccess now exposes. The end-to-end
// "deleted slug cannot be re-claimed" property is exercised against the dev
// server via the kh CLI.

const { mockMemberLimit } = vi.hoisted(() => ({
  mockMemberLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: mockMemberLimit,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  member: {
    id: "id",
    organizationId: "organizationId",
    userId: "userId",
  },
  workflows: {
    deletedAt: "deleted_at",
  },
}));

import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  isWorkflowDeleted,
  workflowNotDeleted,
} from "@/lib/workflow/soft-delete";

const ANON_WORKFLOW = {
  id: "wf-anon",
  userId: "creator",
  organizationId: null,
  isAnonymous: true,
};

describe("isWorkflowDeleted", () => {
  it("returns true when deletedAt is set", () => {
    expect(isWorkflowDeleted({ deletedAt: new Date() })).toBe(true);
  });

  it("returns false when deletedAt is null", () => {
    expect(isWorkflowDeleted({ deletedAt: null })).toBe(false);
  });
});

describe("workflowNotDeleted", () => {
  it("returns a SQL predicate", () => {
    expect(workflowNotDeleted()).toBeDefined();
  });

  it("returns a fresh predicate instance per call (no shared mutable state)", () => {
    expect(workflowNotDeleted()).not.toBe(workflowNotDeleted());
  });
});

describe("getWorkflowAccess soft-delete signal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags isDeleted when the workflow row has a deletedAt timestamp", async () => {
    const access = await getWorkflowAccess(
      { ...ANON_WORKFLOW, deletedAt: new Date() },
      { userId: "creator", organizationId: null }
    );

    expect(access.isDeleted).toBe(true);
    // The creator still has full access -- isDeleted is an orthogonal signal
    // so owner-facing read paths can keep serving the row with a marker.
    expect(access.hasFullAccess).toBe(true);
  });

  it("does not flag isDeleted when deletedAt is null", async () => {
    const access = await getWorkflowAccess(
      { ...ANON_WORKFLOW, deletedAt: null },
      { userId: "creator", organizationId: null }
    );

    expect(access.isDeleted).toBe(false);
  });

  it("does not flag isDeleted when deletedAt is absent (trimmed workflow shape)", async () => {
    const access = await getWorkflowAccess(ANON_WORKFLOW, {
      userId: "creator",
      organizationId: null,
    });

    expect(access.isDeleted).toBe(false);
  });
});
