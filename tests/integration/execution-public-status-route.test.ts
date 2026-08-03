/**
 * Integration tests for public execution status access (FRICTION-09).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveExecutionViewAccess, mockFindMany } = vi.hoisted(() => ({
  mockResolveExecutionViewAccess: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/workflow/execution-access", () => ({
  resolveExecutionViewAccess: mockResolveExecutionViewAccess,
  redactExecutionStatusForPublicView: (payload: unknown) => payload,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutionLogs: {
        findMany: mockFindMany,
      },
    },
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  createTimer: () => () => 1,
}));

vi.mock("@/lib/metrics/instrumentation/api", () => ({
  recordStatusPollMetrics: vi.fn(),
}));

import { GET } from "@/app/api/workflows/executions/[executionId]/status/route";

const EXECUTION_ID = "exec_public_1";

function makeExecution(visibility: "public" | "private") {
  return {
    id: EXECUTION_ID,
    status: "success",
    totalSteps: "1",
    completedSteps: "1",
    currentNodeId: null,
    currentNodeName: null,
    lastSuccessfulNodeId: null,
    lastSuccessfulNodeName: null,
    executionTrace: ["trace-line"],
    error: null,
    transactionHashes: [
      {
        hash: "0xabc",
        nodeId: "n1",
        nodeName: "Transfer",
        chainId: 8453,
      },
    ],
    workflow: {
      id: "wf_1",
      visibility,
    },
  };
}

function createRequest(): Request {
  return new Request(
    `http://localhost:3000/api/workflows/executions/${EXECUTION_ID}/status`
  );
}

describe("GET /api/workflows/executions/[executionId]/status public access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([{ nodeId: "n1", status: "success" }]);
  });

  it("returns 200 for publicReadOnly execution without auth", async () => {
    const execution = makeExecution("public");
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution,
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("success");
    expect(body.transactionHashes).toEqual(execution.transactionHashes);
  });

  it("returns 401 for signInRequired without leaking execution payload", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "signInRequired",
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Authentication required");
  });

  it("returns 404 for notFound", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "notFound",
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });

    expect(response.status).toBe(404);
  });

  it("returns full payload including errorContext for org members", async () => {
    const execution = {
      ...makeExecution("private"),
      status: "error",
      error: "step failed",
      executionTrace: ["trace"],
    };
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "full",
      execution,
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as {
      errorContext: { error: string; executionTrace: string[] } | null;
    };

    expect(response.status).toBe(200);
    expect(body.errorContext?.error).toBe("step failed");
    expect(body.errorContext?.executionTrace).toEqual(["trace"]);
  });
});
