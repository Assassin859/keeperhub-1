import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetDualAuthContext, mockFindFirst, mockAuthenticateApiKey } =
  vi.hoisted(() => ({
    mockGetDualAuthContext: vi.fn(),
    mockFindFirst: vi.fn(),
    mockAuthenticateApiKey: vi.fn(),
  }));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticateApiKey,
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
  shareExecutionStatus?: boolean;
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
      shareExecutionStatus: overrides?.shareExecutionStatus ?? false,
      deletedAt: overrides?.deletedAt ?? null,
    },
  };
}

function makeRequest(): Request {
  return new Request(`http://localhost/executions/${EXECUTION_ID}`);
}

const unauthenticatedContext = {
  userId: null,
  organizationId: null,
  authMethod: "session" as const,
  apiKeyId: null,
  isAnonymous: false,
};

const crossOrgContext = {
  userId: "user_2",
  organizationId: "org_2",
  authMethod: "session" as const,
  apiKeyId: null,
  isAnonymous: false,
};

describe("resolveExecutionViewAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
  });

  it("returns notFound for anonymous session on private workflow", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: "anon_user",
      organizationId: "org_anon",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: true,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns invalidAuth for malformed API key header", async () => {
    mockFindFirst.mockResolvedValue(makeExecution());
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: false,
      error: "Invalid API key format. Expected key starting with kh_",
      statusCode: 401,
    });

    const result = await resolveExecutionViewAccess(
      new Request(`http://localhost/executions/${EXECUTION_ID}`, {
        headers: { Authorization: "Bearer kh_bad" },
      }),
      EXECUTION_ID
    );

    expect(result).toEqual({
      mode: "invalidAuth",
      error: "Invalid API key format. Expected key starting with kh_",
    });
  });

  it("returns notFound when auth context returns an error", async () => {
    mockFindFirst.mockResolvedValue(makeExecution({ visibility: "private" }));
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns accessDenied for authenticated member on deleted workflow", async () => {
    const execution = makeExecution({
      visibility: "private",
      deletedAt: new Date(),
    });
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
      isDeleted: true,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "accessDenied" });
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

  it("returns full for owner viewing own public shared run", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
    });
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

  it("returns publicReadOnly for unauthenticated opted-in public workflow", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns publicReadOnly for unauthenticated opted-in unlisted workflow", async () => {
    const execution = makeExecution({
      visibility: "unlisted",
      shareExecutionStatus: true,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns notFound for unauthenticated public workflow without share opt-in", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: false,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns accessDenied for authenticated cross-org public workflow without share opt-in", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: false,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(crossOrgContext);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: false,
      hasFullAccess: false,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "accessDenied" });
  });

  it("returns notFound for unauthenticated private workflow", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });

  it("returns accessDenied for authenticated cross-org private workflow", async () => {
    const execution = makeExecution({ visibility: "private" });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(crossOrgContext);
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: false,
      hasFullAccess: false,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "accessDenied" });
  });

  it("returns publicReadOnly for API key org context without userId on shared workflow", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: "org_other",
      authMethod: "api_key",
      apiKeyId: "key_1",
      isAnonymous: false,
    });
    mockGetWorkflowAccess.mockResolvedValue({
      isCreatorWithCurrentAccess: false,
      isSameOrg: false,
      hasFullAccess: false,
      isDeleted: false,
    });

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "publicReadOnly", execution });
  });

  it("returns notFound for deleted shared workflow when viewer is not a member", async () => {
    const execution = makeExecution({
      visibility: "public",
      shareExecutionStatus: true,
      deletedAt: new Date(),
    });
    mockFindFirst.mockResolvedValue(execution);
    mockGetDualAuthContext.mockResolvedValue(unauthenticatedContext);

    const result = await resolveExecutionViewAccess(
      makeRequest(),
      EXECUTION_ID
    );

    expect(result).toEqual({ mode: "notFound" });
  });
});

describe("redactExecutionStatusForPublicView", () => {
  it("strips node-identifying fields from public payloads", () => {
    const payload = {
      status: "error",
      nodeStatuses: [{ nodeId: "n1", status: "error" as const }],
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
      transactionHashes: [
        {
          nodeId: "n1",
          nodeName: "Transfer",
          hash: "0xabc",
          chainId: 1,
          network: "internal-rpc-alias",
          iterationIndex: 3,
          verified: true,
          receiptStatus: "success" as const,
        },
      ],
    };

    const redacted = redactExecutionStatusForPublicView(payload);

    expect(redacted.nodeStatuses).toEqual([{ nodeId: "", status: "error" }]);
    expect(redacted.progress.currentNodeId).toBeNull();
    expect(redacted.progress.currentNodeName).toBeNull();
    expect(redacted.errorContext).toEqual({
      failedNodeId: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    });
    // hash + chainId are the only fields the public share view renders
    // (the tx link and its explorer); everything else identifies an
    // internal workflow step or exposes internal execution detail.
    expect(redacted.transactionHashes[0]).toEqual({
      hash: "0xabc",
      chainId: 1,
      nodeId: "",
      nodeName: "",
    });
  });
});
