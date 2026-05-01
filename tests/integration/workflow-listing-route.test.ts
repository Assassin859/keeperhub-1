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
    // Transitioning to listed via this route triggers the publish-time gates,
    // so the existing row must already have a valid inputSchema (or the PATCH
    // body must supply one). Use an existing valid schema here — listing-flow
    // tests cover the gate failures directly.
    const existing = makeWorkflow({
      isListed: false,
      listedAt: null,
      inputSchema: { type: "object" },
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const updated = makeWorkflow({
      isListed: true,
      listedAt: new Date("2026-03-30T00:00:00Z"),
      inputSchema: { type: "object" },
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

  // ──────────────────────────────────────────────────────────────────────
  // Edit-while-listed re-validation
  // ──────────────────────────────────────────────────────────────────────

  const badNode = {
    id: "read-1",
    type: "action",
    data: {
      type: "action",
      config: { actionType: "web3/read-contract", address: "@40" },
    },
  };
  const goodNode = {
    id: "read-1",
    type: "action",
    data: {
      type: "action",
      config: { actionType: "web3/read-contract", address: "0xabc" },
    },
  };

  it("LIST-VALIDATE bare-@ on listed: rejects with 422 INVALID_TEMPLATE_LITERALS", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [badNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INVALID_TEMPLATE_LITERALS");
    expect(data.literals).toContain("@40");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("LIST-VALIDATE bare-@ on unlisted: PATCH succeeds (gate only fires when listed)", async () => {
    const existing = makeWorkflow({
      isListed: false,
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({ isListed: false, nodes: [badNode] }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [badNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE null inputSchema on listed: rejects with 422 INPUT_SCHEMA_REQUIRED", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { inputSchema: null }),
      {
        params: mockParams,
      }
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INPUT_SCHEMA_REQUIRED");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("LIST-VALIDATE transition to listed with bare-@ in existing nodes: rejects", async () => {
    // Backdoor: workflow was created with bare-@ in a node (out-of-band) and
    // the user now PATCHes isListed=true here. The transition-to-listed branch
    // validates the full final state, not just patched fields.
    const existing = makeWorkflow({
      isListed: false,
      inputSchema: { type: "object" },
      nodes: [badNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INVALID_TEMPLATE_LITERALS");
  });

  it("LIST-VALIDATE transition to listed with null existing inputSchema: rejects", async () => {
    const existing = makeWorkflow({
      isListed: false,
      inputSchema: null,
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { isListed: true }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INPUT_SCHEMA_REQUIRED");
  });

  it("LIST-VALIDATE unlist+cleanup: PATCH {isListed: false, nodes: [bad]} on listed workflow succeeds", async () => {
    // The workflow is leaving the listed surface in this same PATCH — the
    // bazaar will never see the post-patch state, so blocking the user from
    // unlisting+cleaning-up in one shot is unnecessary friction. The gate
    // explicitly skips when body.isListed === false on a currently-listed row.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: false,
        listedSlug: "live-wf",
        listedAt: new Date(),
        inputSchema: { type: "object" },
        nodes: [badNode],
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { isListed: false, nodes: [badNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE unlist+null-schema: PATCH {isListed: false, inputSchema: null} on listed workflow succeeds", async () => {
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({ isListed: false, inputSchema: null }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { isListed: false, inputSchema: null }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE write-action removed on listed write workflow: rejects MISSING_WRITE_ACTION", async () => {
    // Third publish-time gate: an author can publish a write workflow then
    // PATCH `nodes` here to remove the only write-action node, leaving the
    // listing live but executing nothing meaningful. Same backdoor class as
    // bare-@ on listed.
    const writeNode = {
      id: "write-1",
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "web3/write-contract",
          contractAddress: "0xabc",
          network: "1",
          abi: "[]",
          abiFunction: "transfer",
        },
      },
    };
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-write",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      workflowType: "write",
      nodes: [writeNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [goodNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("MISSING_WRITE_ACTION");
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("LIST-VALIDATE inputSchema as array: rejects INPUT_SCHEMA_REQUIRED", async () => {
    // Edge case: arrays are objects per typeof but not valid JSON-schema
    // shapes. isInputSchemaPresent rejects them.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);

    const response = await PATCH(createRequest("PATCH", { inputSchema: [] }), {
      params: mockParams,
    });

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toBe("INPUT_SCHEMA_REQUIRED");
  });

  it("LIST-VALIDATE messaging-skip on listed: PATCH adding @everyone in discord/* node still succeeds", async () => {
    // The findBareAtLiterals validator skips action types in the messaging
    // skip-list (discord/*, slack/*, telegram/*, email/*, ai/*, ai-gateway/*,
    // code/*). A PATCH that adds a Discord node with @everyone in the message
    // body must not 422 — same skip semantics as the publish path.
    const discordNode = {
      id: "discord-1",
      type: "action",
      data: {
        type: "action",
        config: {
          actionType: "discord/send-message",
          content: "Alert @here token spiked, @user1 please review",
        },
      },
    };
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "live-wf",
      listedAt: new Date(),
      inputSchema: { type: "object" },
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "live-wf",
        listedAt: new Date(),
        inputSchema: { type: "object" },
        nodes: [discordNode],
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { nodes: [discordNode], edges: [] }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
  });

  it("LIST-VALIDATE legacy: PATCH on listed workflow with null inputSchema, not touching nodes or schema, still succeeds", async () => {
    // Backwards-compat: workflows listed before the gates existed have null
    // inputSchema. They should keep working until the next PATCH that touches
    // nodes or schema. PATCH that only changes other fields (e.g. description)
    // must not retroactively reject them.
    const existing = makeWorkflow({
      isListed: true,
      listedSlug: "legacy",
      listedAt: new Date(),
      inputSchema: null,
      nodes: [goodNode],
    });
    mockWorkflowsFindFirst.mockResolvedValue(existing);
    mockUpdateReturning.mockResolvedValue([
      makeWorkflow({
        isListed: true,
        listedSlug: "legacy",
        listedAt: new Date(),
        inputSchema: null,
        nodes: [goodNode],
        description: "updated text",
      }),
    ]);

    const response = await PATCH(
      createRequest("PATCH", { description: "updated text" }),
      { params: mockParams }
    );

    expect(response.status).toBe(200);
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
