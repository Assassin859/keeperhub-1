/**
 * Integration tests for POST /api/workflows/[workflowId]/simulate.
 *
 * The route authenticates the caller, enforces workflow access and simulates
 * the saved database definition rather than accepting transaction data from
 * the request body.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetDualAuthContext = vi.fn();
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockGetDualAuthContext(...args),
}));

const mockGetWorkflowAccess = vi.fn();
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: (...args: unknown[]) => mockGetWorkflowAccess(...args),
}));

const mockRunWorkflowSimulation = vi.fn();
vi.mock("@/lib/workflow/run-simulation", () => ({
  runWorkflowSimulation: (...args: unknown[]) =>
    mockRunWorkflowSimulation(...args),
}));

let mockWorkflowRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mockWorkflowRows)),
        })),
      })),
    })),
  },
}));

import { POST } from "@/app/api/workflows/[workflowId]/simulate/route";

const OWNER_USER_ID = "user-owner";
const OWNER_ORG_ID = "org-owner";
const OTHER_ORG_ID = "org-other";
const WORKFLOW_ID = "workflow-1";

const savedNodes = [
  {
    id: "trigger-1",
    type: "trigger",
    data: {
      label: "Trigger",
      type: "trigger",
      config: {
        triggerType: "Manual",
      },
    },
  },
  {
    id: "write-1",
    type: "action",
    data: {
      label: "Transfer",
      type: "action",
      config: {
        actionType: "web3/transfer-funds",
        network: "1",
        amount: "0.1",
        recipientAddress: "0xbb0000000000000000000000000000000000bb00",
      },
    },
  },
];

const workflowRow = {
  id: WORKFLOW_ID,
  userId: OWNER_USER_ID,
  organizationId: OWNER_ORG_ID,
  deletedAt: null,
  nodes: savedNodes,
  edges: [],
};

const ownerAuthContext = {
  userId: OWNER_USER_ID,
  organizationId: OWNER_ORG_ID,
  authMethod: "session" as const,
};

const fullAccess = {
  isCreatorWithCurrentAccess: true,
  isSameOrg: true,
  hasFullAccess: true,
  isDeleted: false,
};

const forbiddenAccess = {
  isCreatorWithCurrentAccess: false,
  isSameOrg: false,
  hasFullAccess: false,
  isDeleted: false,
};

const deletedAccess = {
  isCreatorWithCurrentAccess: true,
  isSameOrg: true,
  hasFullAccess: true,
  isDeleted: true,
};

function makeRequest(workflowId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/workflows/${workflowId}/simulate`,
    {
      method: "POST",
    }
  );
}

function makeParams(workflowId: string) {
  return {
    params: Promise.resolve({ workflowId }),
  };
}

describe("/api/workflows/[workflowId]/simulate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowRows = [];
    mockGetDualAuthContext.mockResolvedValue(ownerAuthContext);
    mockGetWorkflowAccess.mockResolvedValue(fullAccess);
    mockRunWorkflowSimulation.mockResolvedValue({
      errors: [],
      warnings: [],
      simulatedNodeCount: 1,
      skippedNodeCount: 0,
    });
  });

  it("returns 401 when authentication fails", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "UNAUTHORIZED",
      status: 401,
    });

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "UNAUTHORIZED",
    });
    expect(mockRunWorkflowSimulation).not.toHaveBeenCalled();
  });

  it("returns 404 when the workflow does not exist", async () => {
    const response = await POST(
      makeRequest("missing-workflow"),
      makeParams("missing-workflow")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
    expect(mockRunWorkflowSimulation).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks full access", async () => {
    mockWorkflowRows = [workflowRow];
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-other",
      organizationId: OTHER_ORG_ID,
      authMethod: "session" as const,
    });
    mockGetWorkflowAccess.mockResolvedValue(forbiddenAccess);

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
    expect(mockRunWorkflowSimulation).not.toHaveBeenCalled();
  });

  it("returns 410 when the workflow is soft-deleted", async () => {
    mockWorkflowRows = [{ ...workflowRow, deletedAt: new Date() }];
    mockGetWorkflowAccess.mockResolvedValue(deletedAccess);

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      ok: false,
      error: "GONE",
    });
    expect(mockRunWorkflowSimulation).not.toHaveBeenCalled();
  });

  it("simulates the saved workflow definition", async () => {
    mockWorkflowRows = [workflowRow];

    const request = makeRequest(WORKFLOW_ID);
    const response = await POST(request, makeParams(WORKFLOW_ID));

    expect(response.status).toBe(200);

    expect(mockGetDualAuthContext).toHaveBeenCalledWith(request, {
      required: true,
    });

    expect(mockRunWorkflowSimulation).toHaveBeenCalledWith({
      organizationId: OWNER_ORG_ID,
      nodes: savedNodes,
    });

    expect(await response.json()).toEqual({
      ok: true,
      result: {
        simulatedNodeCount: 1,
        skippedNodeCount: 0,
      },
    });
  });

  it("includes node-level errors and warnings when present", async () => {
    mockWorkflowRows = [workflowRow];

    mockRunWorkflowSimulation.mockResolvedValue({
      errors: [
        {
          code: "SIMULATION_WOULD_REVERT",
          message: "Transfer would revert: InsufficientBalance()",
          parameterPath: "nodes[1].data.config.recipientAddress",
          nodeId: "write-1",
          fieldKey: "recipientAddress",
        },
      ],
      warnings: [
        {
          code: "SIMULATION_DYNAMIC_INPUT",
          message: "Amount depends on an upstream workflow step",
          parameterPath: "nodes[1].data.config.amount",
          nodeId: "write-1",
          fieldKey: "amount",
        },
      ],
      simulatedNodeCount: 0,
      skippedNodeCount: 1,
    });

    const response = await POST(
      makeRequest(WORKFLOW_ID),
      makeParams(WORKFLOW_ID)
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.result.errors).toEqual([
      expect.objectContaining({
        code: "SIMULATION_WOULD_REVERT",
        nodeId: "write-1",
        fieldKey: "recipientAddress",
      }),
    ]);
    expect(body.result.warnings).toEqual([
      expect.objectContaining({
        code: "SIMULATION_DYNAMIC_INPUT",
        nodeId: "write-1",
        fieldKey: "amount",
      }),
    ]);
  });
});
