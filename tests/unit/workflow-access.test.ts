import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

import { getWorkflowAccess } from "@/lib/workflow/access";

const ORG_WORKFLOW = {
  id: "wf-org",
  userId: "creator",
  organizationId: "org-1",
  isAnonymous: false,
  visibility: "private",
};

describe("getWorkflowAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not grant full access to an org workflow creator who is no longer an org member", async () => {
    mockMemberLimit.mockResolvedValue([]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: null,
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isCreatorWithCurrentAccess).toBe(false);
    expect(mockMemberLimit).toHaveBeenCalledOnce();
  });

  it("grants full access to an org workflow creator who is still an org member", async () => {
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: null,
    });

    expect(access.hasFullAccess).toBe(true);
    expect(access.isCreatorWithCurrentAccess).toBe(true);
  });

  it("does not grant API-key same-org access when the key creator is no longer an org member", async () => {
    mockMemberLimit.mockResolvedValue([]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: "org-1",
      authMethod: "api-key",
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isSameOrg).toBe(false);
    expect(mockMemberLimit).toHaveBeenCalledOnce();
  });

  it("grants API-key same-org access when the key creator is still an org member", async () => {
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: "org-1",
      authMethod: "api-key",
    });

    expect(access.hasFullAccess).toBe(true);
    expect(access.isSameOrg).toBe(true);
  });

  it("does not grant internal execution access when the org workflow creator is no longer an org member", async () => {
    mockMemberLimit.mockResolvedValue([]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: null,
      authMethod: "internal",
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isCreatorWithCurrentAccess).toBe(false);
    expect(mockMemberLimit).toHaveBeenCalledOnce();
  });

  it("preserves anonymous workflow ownership for the creator", async () => {
    const access = await getWorkflowAccess(
      {
        ...ORG_WORKFLOW,
        id: "wf-anon",
        organizationId: null,
        isAnonymous: true,
      },
      {
        userId: "creator",
        organizationId: null,
      }
    );

    expect(access.hasFullAccess).toBe(true);
    expect(access.isCreatorWithCurrentAccess).toBe(true);
    expect(mockMemberLimit).not.toHaveBeenCalled();
  });
});
