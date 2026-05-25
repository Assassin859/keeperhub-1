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
vi.mock("@/lib/db", () => ({
  db: { query: { workflows: { findFirst: mockFindWorkflow } } },
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
