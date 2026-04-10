import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDualAuthContext,
  mockWorkflowsFindFirst,
  mockUpdateReturning,
  mockSelectFrom,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockWorkflowsFindFirst: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockSelectFrom: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: mockWorkflowsFindFirst,
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockUpdateReturning,
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: mockSelectFrom,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { id: "id" },
  workflowPublicTags: {
    workflowId: "workflow_id",
    publicTagId: "public_tag_id",
  },
  publicTags: { id: "id", name: "name", slug: "slug" },
  projects: { id: "id", organizationId: "organization_id" },
  tags: { id: "id", organizationId: "organization_id" },
  workflowExecutions: { workflowId: "workflow_id" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("@/lib/schedule-service", () => ({
  syncWorkflowSchedule: vi.fn().mockResolvedValue({ synced: true }),
}));

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: vi.fn((raw: string) => `SANITIZED:${raw}`),
}));

import { GET, PATCH } from "@/app/api/workflows/[workflowId]/route";

const SANITIZED_PREFIX_RE = /^SANITIZED:/;

function createRequest(
  method: string,
  body?: Record<string, unknown>
): Request {
  const url = "http://localhost:3000/api/workflows/test-workflow-id";
  const init: RequestInit = { method, headers: {} };
  if (body) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

const mockParams = Promise.resolve({ workflowId: "test-workflow-id" });

function makeWorkflow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "test-workflow-id",
    userId: "user-123",
    organizationId: "org-123",
    name: "My Workflow",
    description: "## Hello **world** You must call this API",
    nodes: [],
    edges: [],
    visibility: "private",
    isAnonymous: false,
    enabled: true,
    projectId: null,
    tagId: null,
    isListed: false,
    listedSlug: null,
    listedAt: null,
    inputSchema: null,
    outputMapping: null,
    priceUsdcPerCall: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("PATCH /api/workflows/[workflowId] — listing fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated as owner
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });
    // Default: no public tags
    mockSelectFrom.mockResolvedValue([]);
  });

  it("LIST-01: PATCH with isListed=true sets listedAt server-side when listedAt is null", async () => {
    const existing = makeWorkflow({ isListed: false, listedAt: null });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({
      isListed: true,
      listedAt: new Date("2026-03-30T00:00:00Z"),
    });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isListed).toBe(true);
    expect(data.listedAt).not.toBeNull();
  });

  it("LIST-02 immutability: PATCH with different listedSlug on already-slugged workflow returns 400", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "old-slug",
      listedAt: new Date(),
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { listedSlug: "new-slug" }),
      { params: mockParams }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("slug cannot be changed");
  });

  it("LIST-02 allows: PATCH with listedSlug on unlisted workflow (isListed=false) succeeds", async () => {
    const existing = makeWorkflow({
      isListed: false,
      listedSlug: "old-slug",
      listedAt: null,
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({
      isListed: false,
      listedSlug: "new-slug",
      listedAt: null,
    });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(
      createRequest("PATCH", { listedSlug: "new-slug" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.listedSlug).toBe("new-slug");
  });

  it("LIST-02 uniqueness: db.update throwing with cause.code 23505 returns 400", async () => {
    const existing = makeWorkflow({ listedSlug: null, listedAt: null });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const dbError = new Error("duplicate key value");
    (dbError as Error & { cause: unknown }).cause = { code: "23505" };
    mockUpdateReturning.mockRejectedValue(dbError);

    const response = await PATCH(
      createRequest("PATCH", { listedSlug: "my-slug" }),
      { params: mockParams }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("already in use");
  });

  it("LIST-05: PATCH with priceUsdcPerCall field is accepted and returned", async () => {
    const existing = makeWorkflow();
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({ priceUsdcPerCall: "1.50" });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(
      createRequest("PATCH", { priceUsdcPerCall: "1.50" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.priceUsdcPerCall).toBe("1.50");
  });

  it("Unlist preserves listedSlug, listedAt, and all listing data", async () => {
    const listedAt = new Date("2026-03-01T00:00:00Z");
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "my-workflow",
      listedAt,
      priceUsdcPerCall: "2.00",
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({
      isListed: false,
      listedSlug: "my-workflow",
      listedAt,
      priceUsdcPerCall: "2.00",
    });
    mockUpdateReturning.mockResolvedValue([updated]);

    const response = await PATCH(createRequest("PATCH", { isListed: false }), {
      params: mockParams,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isListed).toBe(false);
    expect(data.listedSlug).toBe("my-workflow");
    expect(data.listedAt).not.toBeNull();
    expect(data.priceUsdcPerCall).toBe("2.00");
  });
});

describe("GET /api/workflows/[workflowId] — description sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFrom.mockResolvedValue([]);
  });

  it("LIST-06 + INFRA-05: non-owner GET on listed workflow receives sanitized description", async () => {
    // Non-owner, different org
    mockGetDualAuthContext.mockResolvedValue({
      userId: "other-user",
      organizationId: "other-org",
      authMethod: "session",
    });

    const workflow = makeWorkflow({
      isListed: true,
      visibility: "public",
      description: "## Hello **world**",
    });
    mockWorkflowsFindFirst.mockResolvedValue(workflow);

    const response = await GET(createRequest("GET"), { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toMatch(SANITIZED_PREFIX_RE);
  });

  it("LIST-06 owner: owner GET on listed workflow receives raw description", async () => {
    // Owner
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });

    const workflow = makeWorkflow({
      isListed: true,
      description: "## Hello **world**",
    });
    mockWorkflowsFindFirst.mockResolvedValue(workflow);

    const response = await GET(createRequest("GET"), { params: mockParams });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toBe("## Hello **world**");
    expect(data.description).not.toMatch(SANITIZED_PREFIX_RE);
  });
});
