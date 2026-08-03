import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetDualAuthContext, mockFindFirst } = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutions: {
        findFirst: mockFindFirst,
      },
    },
  },
}));

import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  redactExecutionStatusForPublicView,
  resolveExecutionViewAccess,
} from "@/lib/workflow/execution-access";

const mockGetWorkflowAccess = vi.mocked(getWorkflowAccess);

const EXECUTION_ID = "exec_test_1";
const WORKFLOW_ID = "wf_test_1";

function makeExecution(overrides?: {
  visibility?: "private" | "public" | "unlisted";
  deletedAt?: Date | null;
}) {
  return {
    id: EXECUTION_ID,
    status: "success",
    workflowId: WORKFLOW_ID,
    totalSteps: "2",
    completedSteps: "2",
    currentNodeId: null,
    currentNodeName: null,
    lastSuccessfulNodeId: null,
    lastSuccessfulNodeName: null,
    executionTrace: ["step-a"],
    error: null,
    transactionHashes: [],
    workflow: {
      id: WORKFLOW_ID,
      name: "Test Workflow",
      userId: "user_1",
      organizationId: "org_1",
      isAnonymous: false,
      visibility: overrides?.visibility ?? "private",
      deletedAt: overrides?.deletedAt ?? null,
    },
  };
}

function makeRequest(): Request {
  return new Request(`http://localhost/executions/${EXECUTION_ID}`);
}

describe("resolveExecutionViewAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns notFound when execution is missing", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns full for org member with access", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_1",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: true,
      isSameOrg: true,
      hasFullAccess: true,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "full", execution });
  });

  it("returns publicReadOnly for unauthenticated public workflow", async () => {
    const execution = makeExecution({ visibility: "public" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns publicReadOnly for unauthenticated unlisted workflow", async () => {
    const execution = makeExecution({ visibility: "unlisted" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns signInRequired for unauthenticated private workflow", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "signInRequired" });
  });

  it("returns notFound for deleted public workflow when viewer is not a member", async () => {
    const execution = makeExecution({
      visibility: "public",
      deletedAt: new Date(),
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });
});

describe("redactExecutionStatusForPublicView", () => {
  it("strips executionTrace and error from errorContext", () => {
    const payload = {
      status: "error",
      nodeStatuses: [],
      progress: {
        totalSteps: 1,
        completedSteps: 0,
        runningSteps: 0,
        currentNodeId: "n1",
        currentNodeName: "Step",
        percentage: 0,
      },
      errorContext: {
        failedNodeId: "n1",
        lastSuccessfulNodeId: null,
        lastSuccessfulNodeName: null,
        executionTrace: ["secret trace"],
        error: "internal error detail",
      },
      transactionHashes: [],
    };

    const redacted = redactExecutionStatusForPublicView(payload);

    expect(redacted.errorContext).toEqual({
      failedNodeId: "n1",
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    });
    expect(redacted.errorContext?.executionTrace).toBeUndefined();
    expect(redacted.errorContext?.error).toBeUndefined();
  });
});
