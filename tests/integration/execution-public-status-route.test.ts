/**
 * Integration tests for public execution status access (FRICTION-09).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveExecutionViewAccess, mockFindMany } = vi.hoisted(() => ({
  mockResolveExecutionViewAccess: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/workflow/execution-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/workflow/execution-access")>();
  return {
    ...actual,
    resolveExecutionViewAccess: mockResolveExecutionViewAccess,
  };
});

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
    status: "error",
    totalSteps: "1",
    completedSteps: "0",
    currentNodeId: "n1",
    currentNodeName: "Step",
    lastSuccessfulNodeId: null,
    lastSuccessfulNodeName: null,
    executionTrace: ["trace-line"],
    error: "internal failure",
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
    mockFindMany.mockResolvedValue([{ nodeId: "n1", status: "error" }]);
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
    expect(body.status).toBe("error");
    expect(body.transactionHashes).toEqual([
      expect.objectContaining({ hash: "0xabc", nodeName: "" }),
    ]);
  });

  it("redacts node-identifying fields from publicReadOnly payloads", async () => {
    const execution = makeExecution("public");
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution,
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as {
      errorContext: {
        failedNodeId: string | null;
        executionTrace?: string[];
        error?: string;
      } | null;
      progress: { currentNodeName: string | null };
    };

    expect(response.status).toBe(200);
    expect(body.errorContext?.failedNodeId).toBeNull();
    expect(body.errorContext?.executionTrace).toBeUndefined();
    expect(body.errorContext?.error).toBeUndefined();
    expect(body.progress.currentNodeName).toBeNull();
  });

  it("returns 401 for invalidAuth", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "invalidAuth",
      error: "Invalid API key format. Expected key starting with kh_",
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toContain("Invalid API key");
  });

  it("returns 403 for accessDenied without leaking execution payload", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "accessDenied",
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe("Access denied");
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
