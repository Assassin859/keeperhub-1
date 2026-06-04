import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDualAuthContext, mockInsert, mockValidateWorkflowIntegrations } =
  vi.hoisted(() => ({
    mockGetDualAuthContext: vi.fn(),
    mockInsert: vi.fn(),
    mockValidateWorkflowIntegrations: vi.fn(),
  }));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: mockInsert,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  projects: { id: "id", organizationId: "organization_id" },
  tags: { id: "id", organizationId: "organization_id" },
  workflows: {},
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/workflows/create/route";

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/workflows/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function workflowBody(nodes: unknown[]) {
  return {
    name: "Invalid workflow",
    nodes,
    edges: [],
  };
}

function baseActionNode(config: Record<string, unknown>) {
  return {
    id: "node-1",
    type: "action",
    data: {
      type: "action",
      config,
    },
  };
}

describe("POST /api/workflows/create action config validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-123",
      organizationId: "org-123",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
  });

  it("rejects invalid action config before inserting workflow", async () => {
    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "discord/send-message",
            Message: "hello",
          }),
        ])
      )
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBe("INVALID_ACTION_CONFIG");
    expect(body.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_FIELD", field: "Message" }),
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          field: "discordMessage",
        }),
      ])
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects unknown action types before inserting workflow", async () => {
    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "webhook/send",
            webhookUrl: "https://example.com",
          }),
        ])
      )
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_ACTION_TYPE" }),
      ])
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects invalid typed protocol fields before inserting workflow", async () => {
    const response = await POST(
      request(
        workflowBody([
          baseActionNode({
            actionType: "aave-v3/supply",
            network: "1",
            asset: "not-an-address",
            amount: "1000000000000000000",
            onBehalfOf: "0x0000000000000000000000000000000000000001",
          }),
        ])
      )
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.invalidFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_FIELD_TYPE",
          field: "asset",
        }),
      ])
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("validates integration ownership after sanitizer moves misplaced config fields", async () => {
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: false,
      invalidIds: ["foreign-integration"],
    });

    const response = await POST(
      request(
        workflowBody([
          {
            id: "node-1",
            type: "action",
            data: {
              type: "action",
              actionType: "discord/send-message",
              integrationId: "foreign-integration",
              discordMessage: "hello",
            },
          },
        ])
      )
    );

    expect(response.status).toBe(403);
    expect(mockValidateWorkflowIntegrations).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          data: expect.objectContaining({
            config: expect.objectContaining({
              integrationId: "foreign-integration",
            }),
          }),
        }),
      ],
      null,
      "org-123"
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
