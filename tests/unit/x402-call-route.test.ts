import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks -- must be defined before any vi.mock() calls
// ---------------------------------------------------------------------------

const {
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockBuildPaymentConfig,
  mockHashPaymentSignature,
  mockFindExistingPayment,
  mockRecordPayment,
  mockResolveCreatorWallet,
  mockExtractPayerAddress,
  mockWithX402,
  mockStart,
  mockExecuteWorkflow,
  mockEnforceExecutionLimit,
  mockCheckConcurrencyLimit,
  mockLogSystemError,
  mockAuthenticateApiKey,
  mockAuthenticateOAuthToken,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockBuildPaymentConfig: vi.fn(),
  mockHashPaymentSignature: vi.fn(),
  mockFindExistingPayment: vi.fn(),
  mockRecordPayment: vi.fn(),
  mockResolveCreatorWallet: vi.fn(),
  mockExtractPayerAddress: vi.fn(),
  mockWithX402: vi.fn(),
  mockStart: vi.fn(),
  mockExecuteWorkflow: vi.fn(),
  mockEnforceExecutionLimit: vi.fn(),
  mockCheckConcurrencyLimit: vi.fn(),
  mockLogSystemError: vi.fn(),
  mockAuthenticateApiKey: vi.fn(),
  mockAuthenticateOAuthToken: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { id: "id", listedSlug: "listed_slug", isListed: "is_listed" },
  workflowExecutions: { id: "id" },
}));

vi.mock("@/lib/x402/server", () => ({
  server: { register: vi.fn() },
}));

vi.mock("@/lib/x402/payment-gate", () => ({
  buildPaymentConfig: mockBuildPaymentConfig,
  hashPaymentSignature: mockHashPaymentSignature,
  findExistingPayment: mockFindExistingPayment,
  recordPayment: mockRecordPayment,
  resolveCreatorWallet: mockResolveCreatorWallet,
  extractPayerAddress: mockExtractPayerAddress,
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: mockAuthenticateOAuthToken,
}));

vi.mock("@/lib/x402/reconcile", () => ({
  isTimeoutError: vi.fn().mockReturnValue(false),
  pollForPaymentConfirmation: vi.fn().mockResolvedValue(false),
}));

vi.mock("@x402/next", () => ({
  withX402: mockWithX402,
}));

vi.mock("workflow/api", () => ({
  start: mockStart,
}));

vi.mock("@/lib/workflow-executor.workflow", () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: mockEnforceExecutionLimit,
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  checkConcurrencyLimit: mockCheckConcurrencyLimit,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: mockLogSystemError,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LISTED_WORKFLOW = {
  id: "wf-1",
  name: "Test Workflow",
  description: "A test workflow",
  organizationId: "org-1",
  listedSlug: "test-workflow",
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: "1.50",
  isListed: true,
  nodes: [],
  edges: [],
  userId: "user-1",
};

const FREE_WORKFLOW = { ...LISTED_WORKFLOW, priceUsdcPerCall: "0" };

const FREE_WORKFLOW_NULL_PRICE = { ...LISTED_WORKFLOW, priceUsdcPerCall: null };

const CREATOR_WALLET = "0xCREATOR_WALLET";

function setupDbSelectWorkflow(row: unknown) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
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

// withX402 mock that calls through to the inner handler (simulates paid flow)
function makePassThroughWithX402() {
  mockWithX402.mockImplementation(
    (innerHandler: (req: Request) => Promise<Response>) => innerHandler
  );
}

// withX402 mock that returns 402 (simulates missing/invalid payment)
function make402WithX402() {
  mockWithX402.mockImplementation(
    () => async () => new Response(null, { status: 402 })
  );
}

function makeRequest(
  slug: string,
  options: {
    body?: Record<string, unknown>;
    paymentSignature?: string;
    method?: string;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = options.paymentSignature;
  }
  return new Request(`http://localhost/api/mcp/workflows/${slug}/call`, {
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/mcp/workflows/[slug]/call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceExecutionLimit.mockResolvedValue({
      blocked: false,
      limitResult: null,
    });
    mockCheckConcurrencyLimit.mockResolvedValue({ allowed: true });
    mockStart.mockResolvedValue({ runId: "run-1" });
    mockRecordPayment.mockResolvedValue(undefined);
    mockBuildPaymentConfig.mockReturnValue({ accepts: { price: "$1.50" } });
    mockHashPaymentSignature.mockReturnValue("hash-abc");
    mockFindExistingPayment.mockResolvedValue(null);
    mockResolveCreatorWallet.mockResolvedValue(CREATOR_WALLET);
    mockExtractPayerAddress.mockReturnValue(null);
    // Default no-op update chain: db.update(table).set(values).where(filter)
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    // Default: caller is authenticated. Tests that exercise the unauthenticated
    // path must explicitly override these to return { authenticated: false }.
    mockAuthenticateOAuthToken.mockReturnValue({
      authenticated: true,
      organizationId: "caller-org-1",
      userId: "caller-user-1",
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: "caller-org-1",
      apiKeyId: "key-1",
    });
  });

  function setUnauthenticated(): void {
    mockAuthenticateOAuthToken.mockReturnValue({ authenticated: false });
    mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
  }

  it("Test 1: returns 404 for unknown slug", async () => {
    setupDbSelectWorkflow(null);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("unknown-slug");
    const params = Promise.resolve({ slug: "unknown-slug" });
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.toLowerCase()).toContain("not found");
  });

  it("Test 2: returns 404 for unlisted workflow", async () => {
    setupDbSelectWorkflow(null); // query filters isListed=true, returns empty
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("unlisted-wf");
    const params = Promise.resolve({ slug: "unlisted-wf" });
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
  });

  it("Test 3: free workflow (price=0) executes immediately without x402", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW);
    setupDbInsertExecution("exec-free-1");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-free-1");
    expect(body.status).toBe("running");
    // withX402 must NOT be called for free workflows
    expect(mockWithX402).not.toHaveBeenCalled();
  });

  it("Test 4: free workflow (priceUsdcPerCall=null) executes without payment", async () => {
    setupDbSelectWorkflow(FREE_WORKFLOW_NULL_PRICE);
    setupDbInsertExecution("exec-free-null");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-free-null");
    expect(mockWithX402).not.toHaveBeenCalled();
  });

  it("Test 5: paid workflow without PAYMENT-SIGNATURE returns 402", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    make402WithX402();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(402);
    expect(mockWithX402).toHaveBeenCalled();
  });

  it("Test 6: paid workflow with valid PAYMENT-SIGNATURE executes and returns executionId", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-paid-1");
    makePassThroughWithX402();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-abc",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-paid-1");
    expect(body.status).toBe("running");
    expect(mockRecordPayment).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it("Test 7: duplicate PAYMENT-SIGNATURE returns original executionId without re-executing", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    mockFindExistingPayment.mockResolvedValue({
      id: "pay-1",
      executionId: "exec-original",
      paymentHash: "hash-abc",
      workflowId: "wf-1",
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-dup",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-original");
    // Workflow must NOT execute again
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("Test 8: returns 503 when org has no wallet configured", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    mockResolveCreatorWallet.mockResolvedValue(null);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.toLowerCase()).toContain("wallet");
  });

  it("Test 9: returns 400 when body fails inputSchema validation", async () => {
    const workflowWithSchema = {
      ...LISTED_WORKFLOW,
      priceUsdcPerCall: "0", // free so we get to validation before payment
      inputSchema: {
        type: "object",
        required: ["tokenAddress", "amount"],
        properties: {
          tokenAddress: { type: "string" },
          amount: { type: "string" },
        },
      },
    };
    setupDbSelectWorkflow(workflowWithSchema);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    // Missing required fields
    const request = makeRequest("test-workflow", {
      body: { tokenAddress: "0xABC" },
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  it("Test 10: payment is recorded BEFORE workflow execution starts", async () => {
    const callOrder: string[] = [];
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-order-1");
    makePassThroughWithX402();
    mockRecordPayment.mockImplementation(() => {
      callOrder.push("recordPayment");
      return Promise.resolve();
    });
    mockStart.mockImplementation(() => {
      callOrder.push("start");
      return Promise.resolve({ runId: "run-1" });
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-order",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    await POST(request, { params });
    const recordIdx = callOrder.indexOf("recordPayment");
    const startIdx = callOrder.indexOf("start");
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeLessThan(startIdx);
  });

  it("Test 11: OPTIONS returns CORS headers", async () => {
    const { OPTIONS } = await import(
      "@/app/api/mcp/workflows/[slug]/call/route"
    );
    const response = await OPTIONS();
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
  });

  it("Test 12: body passing full inputSchema validation proceeds to execution", async () => {
    const workflowWithSchema = {
      ...LISTED_WORKFLOW,
      priceUsdcPerCall: "0",
      inputSchema: {
        type: "object",
        required: ["tokenAddress"],
        properties: {
          tokenAddress: { type: "string" },
        },
      },
    };
    setupDbSelectWorkflow(workflowWithSchema);
    setupDbInsertExecution("exec-schema-ok");
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      body: { tokenAddress: "0xABC" },
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-schema-ok");
  });

  it("Test 13: free workflow without API key returns 401", async () => {
    setUnauthenticated();
    setupDbSelectWorkflow(FREE_WORKFLOW);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow");
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(401);
    // The DB lookup happened, but no execution was created.
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("Test 14: paid workflow does NOT require API key (x402 is the auth)", async () => {
    setUnauthenticated();
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-paid-noauth");
    makePassThroughWithX402();
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-noauth",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    expect(mockAuthenticateOAuthToken).not.toHaveBeenCalled();
  });

  it("Test 15: when recordPayment throws, marks the orphaned execution as failed and does not start the workflow", async () => {
    setupDbSelectWorkflow(LISTED_WORKFLOW);
    setupDbInsertExecution("exec-orphan-1");
    makePassThroughWithX402();
    mockRecordPayment.mockRejectedValue(new Error("db connection lost"));

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockDbUpdate.mockReturnValue({ set: setMock });

    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeRequest("test-workflow", {
      paymentSignature: "sig-orphan",
    });
    const params = Promise.resolve({ slug: "test-workflow" });
    const response = await POST(request, { params });

    // The error propagates through the outer POST try/catch as a 500.
    expect(response.status).toBe(500);
    // The execution row was marked failed before the error escaped.
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("recordPayment failed"),
      })
    );
    // The workflow itself was never started.
    expect(mockStart).not.toHaveBeenCalled();
  });
});
