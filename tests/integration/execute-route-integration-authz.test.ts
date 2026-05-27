/**
 * Route-level wiring for per-integration authorization (KEEP-613).
 *
 * The rule table is unit-tested in tests/unit/integration-authorization.test.ts.
 * This proves the execute route honors an unauthorized result: it must return
 * 403 and must call validateWorkflowIntegrations with the CALLER's principal
 * (not the workflow owner) on the interactive path - the line that closes the
 * lateral-movement hole.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

const mockAuthenticateInternalService = vi.fn();
const mockGetDualAuthContext = vi.fn();
const mockGetWorkflowAccess = vi.fn();
const mockValidateWorkflowIntegrations = vi.fn();
const mockFindWorkflow = vi.fn();

vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: mockAuthenticateInternalService,
}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: mockGetWorkflowAccess,
}));
vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));
const mockOwnerLimit = vi.fn().mockResolvedValue([{ deactivatedAt: null }]);
vi.mock("@/lib/db", () => ({
  db: {
    query: { workflows: { findFirst: mockFindWorkflow } },
    // The route now loads the owner's deactivatedAt to gate executability.
    // Default to an active owner.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mockOwnerLimit })),
      })),
    })),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", deactivatedAt: "deactivated_at" },
  workflows: { id: "id", userId: "user_id" },
  workflowExecutions: { id: "id" },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

// Workflow owned by user A in org_1, referencing a private integration A owns.
const workflow = {
  id: "wf_1",
  userId: "owner_a",
  organizationId: "org_1",
  enabled: true,
  nodes: [
    {
      id: "node-1",
      type: "action",
      data: { config: { integrationId: "int_priv" } },
    },
  ],
  edges: [],
  deletedAt: null,
  isAnonymous: false,
};

async function callExecute(): Promise<Response> {
  const { POST } = await import(
    "@/app/api/workflow/[workflowId]/execute/route"
  );
  const request = new Request("http://localhost/api/workflow/wf_1/execute", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return POST(request, { params: Promise.resolve({ workflowId: "wf_1" }) });
}

describe("execute route - per-integration authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateInternalService.mockReturnValue({ authenticated: false });
    mockFindWorkflow.mockResolvedValue(workflow);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });
  });

  it("returns 403 when the caller is not authorized for a referenced integration", async () => {
    // member_b has workflow access (same org) but is not authorized for the
    // owner's private integration.
    mockGetDualAuthContext.mockResolvedValue({
      userId: "member_b",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: false,
      invalidIds: ["int_priv"],
    });

    const response = await callExecute();

    expect(response.status).toBe(403);
  });

  it("authorizes against the caller's principal, not the workflow owner", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: "member_b",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: false,
      invalidIds: ["int_priv"],
    });

    await callExecute();

    // The crux of the fix: the caller (member_b) is the principal, not the
    // workflow owner (owner_a). The org dimension is the workflow's org.
    expect(mockValidateWorkflowIntegrations).toHaveBeenCalledWith(
      workflow.nodes,
      "member_b",
      "org_1"
    );
  });
});

describe("execute route - lifecycle executability gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateInternalService.mockReturnValue({ authenticated: false });
    mockFindWorkflow.mockResolvedValue(workflow);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });
    mockOwnerLimit.mockResolvedValue([{ deactivatedAt: null }]);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "owner_a",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
  });

  it("blocks a disabled workflow on the internal (automated) path with 404", async () => {
    mockAuthenticateInternalService.mockReturnValue({
      authenticated: true,
      service: "scheduler",
    });
    mockFindWorkflow.mockResolvedValue({ ...workflow, enabled: false });

    const response = await callExecute();

    expect(response.status).toBe(404);
    // Gate rejected before any integration check ran.
    expect(mockValidateWorkflowIntegrations).not.toHaveBeenCalled();
  });

  it("allows a disabled workflow on the interactive path (editor test run)", async () => {
    mockFindWorkflow.mockResolvedValue({ ...workflow, enabled: false });
    // Force a 403 downstream so we can prove the disabled gate did NOT short
    // -circuit: reaching the integration check means the workflow passed.
    mockValidateWorkflowIntegrations.mockResolvedValue({
      valid: false,
      invalidIds: ["int_priv"],
    });

    const response = await callExecute();

    expect(mockValidateWorkflowIntegrations).toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("blocks a soft-deleted workflow on the interactive path with 404", async () => {
    mockFindWorkflow.mockResolvedValue({ ...workflow, deletedAt: new Date() });

    const response = await callExecute();

    expect(response.status).toBe(404);
    expect(mockValidateWorkflowIntegrations).not.toHaveBeenCalled();
  });

  it("blocks a deactivated-owner workflow on the interactive path with 404", async () => {
    mockOwnerLimit.mockResolvedValue([{ deactivatedAt: new Date() }]);

    const response = await callExecute();

    expect(response.status).toBe(404);
    expect(mockValidateWorkflowIntegrations).not.toHaveBeenCalled();
  });
});
