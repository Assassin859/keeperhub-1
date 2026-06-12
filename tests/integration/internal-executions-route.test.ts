import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// --- Authentication: always authenticated as the scheduler service. ---
const mockAuthResult = {
  authenticated: true,
  caller: "scheduler" as const,
  scheme: "hmac" as const,
  error: "Unauthorized",
  status: 401,
};
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(async () => mockAuthResult),
}));

// --- Guards: default to allowed; tests flip these as needed. ---
const enforceExecutionLimit = vi.fn(
  async (..._args: unknown[]) => ({ blocked: false }) as { blocked: boolean }
);
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: (...args: unknown[]) => enforceExecutionLimit(...args),
}));

const enforceWorkflowFeatures = vi.fn(
  async (..._args: unknown[]) => ({ blocked: false }) as { blocked: boolean }
);
vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: (...args: unknown[]) =>
    enforceWorkflowFeatures(...args),
}));
vi.mock("@/lib/features", () => ({
  extractActionTypeNodes: vi.fn(() => []),
}));

// withBackstopCapture wraps the insert; just run the callback.
vi.mock("@/lib/security/backstop-capture", () => ({
  withBackstopCapture: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

// Record the source buildAttribution was called with so trigger-source
// passthrough can be asserted.
const buildAttribution = vi.fn((input: { source: string }) => ({
  triggerSource: input.source,
}));
vi.mock("@/lib/security/request-attribution", () => ({
  buildAttribution: (input: { source: string }) => buildAttribution(input),
}));

// The route calls buildAttribution({ request, source }); assert on source only.
const sourceArg = (source: string) => expect.objectContaining({ source });

// --- DB mock: records insert values and update payloads. ---
let mockWorkflow: {
  organizationId: string | null;
  deletedAt: Date | null;
  nodes: unknown[];
  userId: string;
} | null;
let mockExistingExecution: { id: string; status: string } | null;
let insertedValues: Record<string, unknown> | null;
let updatedSet: Record<string, unknown> | null;

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: vi.fn(async () => mockWorkflow),
      },
      workflowExecutions: {
        findFirst: vi.fn(async () => mockExistingExecution),
      },
    },
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        insertedValues = values;
        return {
          returning: () => [{ id: "exec_created" }],
        };
      },
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updatedSet = values;
        return { where: () => Promise.resolve(undefined) };
      },
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", status: "status" },
  workflows: { id: "id" },
}));

import { PATCH } from "@/app/api/internal/executions/[executionId]/route";
import { POST } from "@/app/api/internal/executions/route";

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/internal/executions", {
    method: "POST",
    headers: {
      "X-Service-Key": "test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/internal/executions/exec_1", {
    method: "PATCH",
    headers: {
      "X-Service-Key": "test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const patchContext = {
  params: Promise.resolve({ executionId: "exec_1" }),
};

describe("POST /api/internal/executions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult.authenticated = true;
    mockWorkflow = {
      organizationId: "org_1",
      deletedAt: null,
      nodes: [],
      userId: "wf_owner",
    };
    insertedValues = null;
    enforceExecutionLimit.mockResolvedValue({ blocked: false });
    enforceWorkflowFeatures.mockResolvedValue({ blocked: false });
  });

  it("creates a running row by default and returns the execution id", async () => {
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1" })
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.executionId).toBe("exec_created");
    expect(insertedValues?.status).toBe("running");
    expect(insertedValues?.billable).toBe(true);
    expect(enforceExecutionLimit).toHaveBeenCalledTimes(1);
  });

  it("creates a phantom row and skips the execution-limit guard", async () => {
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1", status: "phantom" })
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.executionId).toBe("exec_created");
    expect(insertedValues?.status).toBe("phantom");
    // A phantom must not count toward billing until it actually runs.
    expect(insertedValues?.billable).toBe(false);
    // Quota is charged when the executor upgrades to running, not now.
    expect(enforceExecutionLimit).not.toHaveBeenCalled();
  });

  it("attributes the row to the supplied trigger source", async () => {
    await POST(
      postRequest({
        workflowId: "wf_1",
        userId: "user_1",
        status: "phantom",
        triggerSource: "block",
      })
    );

    expect(buildAttribution).toHaveBeenCalledWith(sourceArg("block"));
  });

  it("defaults an unknown trigger source to internal", async () => {
    await POST(
      postRequest({
        workflowId: "wf_1",
        userId: "user_1",
        triggerSource: "bogus",
      })
    );

    expect(buildAttribution).toHaveBeenCalledWith(sourceArg("internal"));
  });

  it("returns 400 when workflowId is missing", async () => {
    const response = await POST(postRequest({ userId: "user_1" }));
    expect(response.status).toBe(400);
  });

  it("derives userId from the workflow when omitted (cron path)", async () => {
    const response = await POST(postRequest({ workflowId: "wf_1" }));

    expect(response.status).toBe(201);
    expect(insertedValues?.userId).toBe("wf_owner");
  });

  it("returns 404 for a soft-deleted workflow", async () => {
    mockWorkflow = {
      organizationId: "org_1",
      deletedAt: new Date(),
      nodes: [],
      userId: "wf_owner",
    };
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1" })
    );
    expect(response.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthResult.authenticated = false;
    const response = await POST(
      postRequest({ workflowId: "wf_1", userId: "user_1" })
    );
    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/internal/executions/[executionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult.authenticated = true;
    mockExistingExecution = { id: "exec_1", status: "phantom" };
    updatedSet = null;
  });

  it("writes a valid error code and derives type/category from the registry", async () => {
    const response = await PATCH(
      patchRequest({ status: "error", error: "boom", errorCode: "BS-0001" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(updatedSet?.status).toBe("error");
    expect(updatedSet?.errorCode).toBe("BS-0001");
    expect(updatedSet?.errorType).toBe("system");
    // BS-0001 is classified workflow_engine in the registry.
    expect(updatedSet?.errorCategory).toBe("workflow_engine");
  });

  it("rejects an unknown error code with 400", async () => {
    const response = await PATCH(
      patchRequest({ status: "error", error: "boom", errorCode: "Z-9999" }),
      patchContext
    );
    expect(response.status).toBe(400);
  });

  it("accepts an error without a code (no code fields written)", async () => {
    const response = await PATCH(
      patchRequest({ status: "error", error: "boom" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(updatedSet?.error).toBe("boom");
    expect(updatedSet?.errorCode).toBeUndefined();
  });

  it("does not attach a code on a success transition", async () => {
    const response = await PATCH(
      patchRequest({ status: "success" }),
      patchContext
    );

    expect(response.status).toBe(200);
    expect(updatedSet?.errorCode).toBeUndefined();
  });

  it("rejects an invalid status with 400", async () => {
    const response = await PATCH(
      patchRequest({ status: "phantom" }),
      patchContext
    );
    expect(response.status).toBe(400);
  });
});
