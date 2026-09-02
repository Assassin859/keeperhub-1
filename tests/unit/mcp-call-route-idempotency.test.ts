import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockDbUpdateSet,
  mockDbTransaction,
  mockRecordPayment,
  mockResolveExecutionOrgMetadata,
  mockStart,
  mockEnforceExecutionLimit,
  mockCheckConcurrencyLimit,
  mockChargePaygIfBillable,
  mockBuildCallCompletionResponse,
  mockDetectProtocol,
  mockGatePayment,
  mockBeginIdempotentFromRequest,
  mockIdempotencyEarlyResponse,
  mockRecordIdempotentResponse,
  mockSafeRecordIdempotentResponse,
  mockWithIdempotencyHeartbeat,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbUpdateSet: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockRecordPayment: vi.fn(),
  mockResolveExecutionOrgMetadata: vi.fn(),
  mockStart: vi.fn(),
  mockEnforceExecutionLimit: vi.fn(),
  mockCheckConcurrencyLimit: vi.fn(),
  mockChargePaygIfBillable: vi.fn(),
  mockBuildCallCompletionResponse: vi.fn(),
  mockDetectProtocol: vi.fn(),
  mockGatePayment: vi.fn(),
  mockBeginIdempotentFromRequest: vi.fn(),
  mockIdempotencyEarlyResponse: vi.fn(),
  mockRecordIdempotentResponse: vi.fn(
    (_idem: unknown, response: Response, _disposition?: string) =>
      Promise.resolve(response)
  ),
  mockSafeRecordIdempotentResponse: vi.fn(
    (
      _idem: unknown,
      response: Response,
      _disposition?: string,
      _context?: string
    ) => Promise.resolve(response)
  ),
  mockWithIdempotencyHeartbeat: vi.fn((_idem: unknown, work: () => unknown) =>
    work()
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    transaction: mockDbTransaction,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    listedSlug: "listed_slug",
    isListed: "is_listed",
    tagId: "tag_id",
    enabled: "enabled",
    deletedAt: "deleted_at",
    deactivatedAt: "deactivated_at",
    organizationId: "organization_id",
    userId: "user_id",
  },
  workflowExecutions: { id: "id" },
  tags: { id: "id", name: "name" },
  organization: { id: "id", deactivatedAt: "deactivated_at" },
}));

vi.mock("@/lib/db/org-helpers", () => ({
  resolveExecutionOrgMetadata: mockResolveExecutionOrgMetadata,
}));

vi.mock("workflow/api", () => ({
  start: mockStart,
}));

vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mockEnforceExecutionLimit,
}));

vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: mockChargePaygIfBillable,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  checkConcurrencyLimit: mockCheckConcurrencyLimit,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine", DATABASE: "database" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/payments/x402/execution-wait", () => ({
  buildCallCompletionResponse: mockBuildCallCompletionResponse,
}));

vi.mock("@/lib/payments/x402/payment-gate", () => ({
  recordPayment: mockRecordPayment,
  resolveCreatorWallet: vi.fn().mockResolvedValue("0xCreator"),
  extractPayerAddress: vi.fn().mockReturnValue("0xpayer"),
}));

vi.mock("@/lib/payments/router", () => ({
  gatePayment: mockGatePayment,
  detectProtocol: mockDetectProtocol,
}));

vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: vi.fn().mockReturnValue({
    errorCategory: "workflow_engine",
    errorType: "system",
  }),
}));
vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/idempotency", () => ({
  beginIdempotentFromRequest: (...args: unknown[]) =>
    mockBeginIdempotentFromRequest(...args),
  idempotencyEarlyResponse: (...args: unknown[]) =>
    mockIdempotencyEarlyResponse(...args),
  recordIdempotentResponse: (
    idem: unknown,
    response: Response,
    disposition?: string
  ) => mockRecordIdempotentResponse(idem, response, disposition),
  safeRecordIdempotentResponse: (
    idem: unknown,
    response: Response,
    disposition?: string,
    context?: string
  ) => mockSafeRecordIdempotentResponse(idem, response, disposition, context),
  withIdempotencyHeartbeat: (idem: unknown, work: () => unknown) =>
    mockWithIdempotencyHeartbeat(idem, work),
}));

vi.mock("mppx", () => ({
  Credential: {
    fromRequest: vi.fn().mockReturnValue({ source: "0xMppPayer" }),
  },
}));

vi.mock("@/lib/payments/mpp/server", () => ({
  extractMppPayerAddress: vi.fn().mockReturnValue("0xmpppayer"),
}));

vi.mock("server-only", () => ({}));

const FREE_WORKFLOW = {
  id: "wf-1",
  name: "Test Workflow",
  description: "A test workflow",
  organizationId: "org-1",
  listedSlug: "test-workflow",
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: "0",
  isListed: true,
  enabled: true,
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { type: "trigger", enabled: true },
    },
    {
      id: "action-1",
      type: "action",
      position: { x: 0, y: 0 },
      data: { type: "action", enabled: true },
    },
  ],
  edges: [{ id: "e1", source: "trigger-1", target: "action-1" }],
  userId: "user-1",
};

const PAID_WORKFLOW = {
  ...FREE_WORKFLOW,
  id: "wf-paid",
  listedSlug: "paid-workflow",
  priceUsdcPerCall: "0.10",
};

function setupDbSelectWorkflow(row: unknown) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(row ? [row] : []),
          }),
        }),
      }),
    }),
  });
}

function setupDbInsertExecution(executionId: string) {
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: executionId }]),
    }),
  });
}

function makeRequest(
  slug: string,
  options?: {
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    paymentSignature?: string;
  }
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options?.paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = options.paymentSignature;
  }
  return new Request(`http://localhost/api/mcp/workflows/${slug}/call`, {
    method: "POST",
    headers,
    body: JSON.stringify(options?.body ?? {}),
  });
}

function makePassThroughGatePayment(): void {
  mockGatePayment.mockImplementation(
    (
      request: Request,
      _workflow: unknown,
      _wallet: string,
      createHandler: (meta: {
        protocol: string;
        chain: string;
        payerAddress: string | null;
        paymentHash: string;
      }) => (req: Request) => Promise<Response>,
      options?: { idem?: unknown }
    ) => {
      const handler = createHandler({
        protocol: "x402",
        chain: "base",
        payerAddress: "0xPayer",
        paymentHash: "hash-first",
      });
      expect(options?.idem).toBeDefined();
      return handler(request as never);
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnforceExecutionLimit.mockResolvedValue({ blocked: false });
  mockCheckConcurrencyLimit.mockResolvedValue({ allowed: true });
  mockChargePaygIfBillable.mockResolvedValue({ applicable: false });
  mockResolveExecutionOrgMetadata.mockResolvedValue({
    slug: "org-slug",
    plan: "free",
  });
  mockBuildCallCompletionResponse.mockResolvedValue({
    executionId: "exec-1",
    status: "running",
  });
  mockDbUpdateSet.mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
  mockStart.mockResolvedValue({ runId: "run-1" });
  mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "proceed" });
  mockIdempotencyEarlyResponse.mockReturnValue(null);
  mockRecordIdempotentResponse.mockImplementation(
    (_idem: unknown, response: Response, _disposition?: string) =>
      Promise.resolve(response)
  );
  mockSafeRecordIdempotentResponse.mockImplementation(
    (
      _idem: unknown,
      response: Response,
      _disposition?: string,
      _context?: string
    ) => Promise.resolve(response)
  );
  mockWithIdempotencyHeartbeat.mockImplementation(
    (_idem: unknown, work: () => unknown) => work()
  );
  mockRecordPayment.mockResolvedValue(undefined);
  mockDbTransaction.mockImplementation(
    async (cb: (tx: { update: typeof mockDbUpdate }) => Promise<unknown>) =>
      cb({
        update: mockDbUpdate,
      })
  );
});

describe("marketplace call route HTTP idempotency", () => {
  it("does not begin idempotency on a free read with a key", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-1");

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const response = await POST(
      makeRequest("test-workflow", {
        body: { foo: "bar" },
        idempotencyKey: "idem-free-1",
      }),
      { params: Promise.resolve({ slug: "test-workflow" }) }
    );

    expect(response.status).toBe(200);
    expect(mockBeginIdempotentFromRequest).not.toHaveBeenCalled();
    expect(mockDbInsert).toHaveBeenCalled();
    expect(mockSafeRecordIdempotentResponse).not.toHaveBeenCalled();
  });

  it("scopes paid idempotency to the verified payer address", async () => {
    setupDbSelectWorkflow(PAID_WORKFLOW);
    setupDbInsertExecution("exec-paid-1");
    mockDetectProtocol.mockReturnValue("x402");
    makePassThroughGatePayment();

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    await POST(
      makeRequest("paid-workflow", {
        idempotencyKey: "idem-paid-scope",
        paymentSignature: "sig-first",
      }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );

    expect(mockBeginIdempotentFromRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        scope: "mcp-call:wf-paid:0xpayer",
      })
    );
  });

  it("replays early and does not insert an execution when the key is already complete", async () => {
    setupDbSelectWorkflow(PAID_WORKFLOW);
    mockDetectProtocol.mockReturnValue("x402");
    mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "replay" });
    mockIdempotencyEarlyResponse.mockReturnValue({
      status: 200,
      body: {
        executionId: "exec-cached",
        status: "success",
        idempotentReplay: true,
      },
    });

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const response = await POST(
      makeRequest("paid-workflow", {
        idempotencyKey: "idem-replay",
        paymentSignature: "sig-replay",
      }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );
    const body = (await response.json()) as { executionId: string };

    expect(response.status).toBe(200);
    expect(body.executionId).toBe("exec-cached");
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockGatePayment).not.toHaveBeenCalled();
  });

  it("does not begin idempotency on a paid 402 probe without payment headers", async () => {
    setupDbSelectWorkflow(PAID_WORKFLOW);
    mockDetectProtocol.mockReturnValue(null);
    mockGatePayment.mockResolvedValue(
      new Response(JSON.stringify({ error: "Payment Required" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })
    );

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const response = await POST(
      makeRequest("paid-workflow", { idempotencyKey: "idem-402" }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );

    expect(response.status).toBe(402);
    expect(mockBeginIdempotentFromRequest).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("replays before gatePayment on same key with a new payment signature", async () => {
    setupDbSelectWorkflow(PAID_WORKFLOW);
    setupDbInsertExecution("exec-paid-1");
    mockDetectProtocol.mockReturnValue("x402");
    makePassThroughGatePayment();

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");

    const first = await POST(
      makeRequest("paid-workflow", {
        idempotencyKey: "idem-paid-replay",
        paymentSignature: "sig-first",
      }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );
    expect(first.status).toBe(200);
    expect(mockGatePayment).toHaveBeenCalledTimes(1);
    expect(mockRecordPayment).toHaveBeenCalledTimes(1);

    mockIdempotencyEarlyResponse.mockReturnValue({
      status: 200,
      body: { executionId: "exec-cached", status: "success" },
    });

    const second = await POST(
      makeRequest("paid-workflow", {
        idempotencyKey: "idem-paid-replay",
        paymentSignature: "sig-second",
      }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );
    const body = (await second.json()) as { executionId: string };

    expect(second.status).toBe(200);
    expect(body.executionId).toBe("exec-cached");
    expect(mockGatePayment).toHaveBeenCalledTimes(1);
    expect(mockRecordPayment).toHaveBeenCalledTimes(1);
  });

  it("returns 503 and releases idempotency when x402 recordPayment fails", async () => {
    setupDbSelectWorkflow(PAID_WORKFLOW);
    setupDbInsertExecution("exec-paid-fail");
    mockDetectProtocol.mockReturnValue("x402");
    makePassThroughGatePayment();
    mockDbTransaction.mockRejectedValue(new Error("db down"));
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ workflowId: PAID_WORKFLOW.id }]),
        }),
      }),
    });

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const response = await POST(
      makeRequest("paid-workflow", {
        idempotencyKey: "idem-record-fail",
        paymentSignature: "sig-fail",
      }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toContain("Payment could not be recorded");
    expect(mockSafeRecordIdempotentResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Response),
      "release",
      expect.any(String)
    );
  });

  it("starts execution and finalizes success when MPP recordPayment fails", async () => {
    setupDbSelectWorkflow(PAID_WORKFLOW);
    setupDbInsertExecution("exec-mpp-fail");
    mockDetectProtocol.mockReturnValue("x402");
    mockGatePayment.mockImplementation(
      (
        request: Request,
        _workflow: unknown,
        _wallet: string,
        createHandler: (meta: {
          protocol: string;
          chain: string;
          payerAddress: string | null;
          paymentHash: string;
        }) => (req: Request) => Promise<Response>
      ) => {
        const handler = createHandler({
          protocol: "mpp",
          chain: "tempo",
          payerAddress: "0xMppPayer",
          paymentHash: "hash-mpp",
        });
        return handler(request as never);
      }
    );
    mockDbTransaction.mockRejectedValue(new Error("db down"));
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const promise = Promise.resolve(undefined);
          return Object.assign(promise, {
            returning: vi
              .fn()
              .mockResolvedValue([{ workflowId: PAID_WORKFLOW.id }]),
          });
        }),
      }),
    });

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const response = await POST(
      makeRequest("paid-workflow", {
        idempotencyKey: "idem-mpp-fail",
        paymentSignature: "sig-mpp",
      }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );

    expect(response.status).toBe(200);
    expect(mockStart).toHaveBeenCalled();
    expect(mockSafeRecordIdempotentResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Response),
      "success",
      expect.stringContaining("MPP recordPayment")
    );
  });

  it("returns the paid response when idempotency finalize throws after execution starts", async () => {
    setupDbSelectWorkflow(PAID_WORKFLOW);
    setupDbInsertExecution("exec-finalize-fail");
    mockDetectProtocol.mockReturnValue("x402");
    makePassThroughGatePayment();
    mockSafeRecordIdempotentResponse.mockImplementation(
      async (_idem: unknown, response: Response) => {
        try {
          await mockRecordIdempotentResponse(_idem, response, "success");
        } catch {
          // mirror safeRecordIdempotentResponse: deliver response anyway
        }
        return response;
      }
    );
    mockRecordIdempotentResponse.mockRejectedValueOnce(
      new Error("db finalize down")
    );

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const response = await POST(
      makeRequest("paid-workflow", {
        idempotencyKey: "idem-finalize-fail",
        paymentSignature: "sig-finalize",
      }),
      { params: Promise.resolve({ slug: "paid-workflow" }) }
    );
    const body = (await response.json()) as { executionId: string };

    expect(response.status).toBe(200);
    expect(body.executionId).toBe("exec-1");
    expect(mockStart).toHaveBeenCalled();
  });
});
