import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regex at top level per Biome useTopLevelRegex rule
const NO_QUERY_STRING_RE = /\/api\/mcp\/workflows$/;

// KEEP-393: regex constants used in 402-augmentation tests, hoisted to
// module scope per the lint/performance/useTopLevelRegex rule.
const SLUG_RE = /yield-cmp/;
const AMOUNT_RE = /50000/;
const NETWORK_RE = /eip155:8453/;
const PAYMENT_SIGNER_RE = /paymentSigner\.fetch/;
const AGENTCASH_RE = /mcp__agentcash__fetch/;
const PAID_WEIRD_RE = /Paid workflow "weird"/;
const API_402_PREFIX_RE = /^API call failed: 402/;
const API_500_RE = /API call failed: 500/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockServer(): {
  server: McpServer;
  registeredTools: Array<{
    name: string;
    handler: (...args: unknown[]) => unknown;
  }>;
} {
  const registeredTools: Array<{
    name: string;
    handler: (...args: unknown[]) => unknown;
  }> = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        _annotations: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        registeredTools.push({ name, handler });
      }
    ),
  } as unknown as McpServer;
  return { server, registeredTools };
}

// ---------------------------------------------------------------------------
// oauth-scopes tests
// ---------------------------------------------------------------------------

describe("oauth-scopes: search_workflows and call_workflow scope assignments", () => {
  it("Test 1: isToolAllowed('search_workflows', 'mcp:read') returns true", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("search_workflows", "mcp:read")).toBe(true);
  });

  it("Test 2: isToolAllowed('call_workflow', 'mcp:read') returns false", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("call_workflow", "mcp:read")).toBe(false);
  });

  it("Test 3: isToolAllowed('call_workflow', 'mcp:write') returns true", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("call_workflow", "mcp:write")).toBe(true);
  });

  it("Test 4: isToolAllowed('call_workflow', 'mcp:admin') returns true", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("call_workflow", "mcp:admin")).toBe(true);
  });

  it("Test 5: search_workflows accessible with mcp:write (READ_TOOLS spread into WRITE_TOOLS)", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("search_workflows", "mcp:write")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerMetaTools registration tests
// ---------------------------------------------------------------------------

describe("registerMetaTools: tool registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Test 6: registerMetaTools registers all 8 meta-tools (4 protocol/marketplace + 4 curator)", async () => {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, "http://localhost:3000", "Bearer test-token");
    expect(registeredTools.length).toBe(8);
    expect(registeredTools.map((t) => t.name)).toEqual([
      "search_protocol_actions",
      "execute_protocol_action",
      "search_workflows",
      "call_workflow",
      "list_workflow",
      "unlist_workflow",
      "update_workflow_listing",
      "get_workflow_listing",
    ]);
  });

  it("Test 7: registerMetaTools registers search_workflows as the 3rd tool", async () => {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, "http://localhost:3000", "Bearer test-token");
    const names = registeredTools.map((t) => t.name);
    expect(names).toContain("search_workflows");
    expect(names.indexOf("search_workflows")).toBe(2);
  });

  it("Test 8: registerMetaTools registers call_workflow as the 4th tool", async () => {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, "http://localhost:3000", "Bearer test-token");
    const names = registeredTools.map((t) => t.name);
    expect(names).toContain("call_workflow");
    expect(names.indexOf("call_workflow")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// search_workflows behavior tests
// ---------------------------------------------------------------------------

describe("search_workflows tool behavior", () => {
  const BASE_URL = "http://localhost:3000";
  const AUTH = "Bearer tok";

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (_key: string) => "application/json",
        },
        json: async () => ({ workflows: [], total: 0 }),
        text: async () => "",
      })
    );
  });

  async function invokeSearchWorkflows(
    args: Record<string, unknown>,
    scope?: string
  ) {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, BASE_URL, AUTH, scope);
    const tool = registeredTools.find((t) => t.name === "search_workflows");
    if (!tool) {
      throw new Error("search_workflows not registered");
    }
    return tool.handler(args);
  }

  it("Test 9: search_workflows with query='swap' calls GET /api/mcp/workflows?q=swap", async () => {
    await invokeSearchWorkflows({ query: "swap" });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/mcp/workflows");
    expect(calledUrl).toContain("q=swap");
  });

  it("Test 10: search_workflows with category='defi' calls GET /api/mcp/workflows?category=defi", async () => {
    await invokeSearchWorkflows({ category: "defi" });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("category=defi");
  });

  it("Test 11: search_workflows with chain='8453' calls GET /api/mcp/workflows?chain=8453", async () => {
    await invokeSearchWorkflows({ chain: "8453" });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("chain=8453");
  });

  it("Test 12: search_workflows with all 3 params builds correct query string", async () => {
    await invokeSearchWorkflows({
      query: "swap",
      category: "defi",
      chain: "8453",
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=swap");
    expect(calledUrl).toContain("category=defi");
    expect(calledUrl).toContain("chain=8453");
  });

  it("Test 13: search_workflows with no params calls GET /api/mcp/workflows with no query string", async () => {
    await invokeSearchWorkflows({});
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(NO_QUERY_STRING_RE);
  });

  it("Test 14: search_workflows uses GET method", async () => {
    await invokeSearchWorkflows({ query: "test" });
    const fetchMock = vi.mocked(globalThis.fetch);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.method).toBe("GET");
  });

  it("Test 15: search_workflows returns content text with JSON", async () => {
    const result = (await invokeSearchWorkflows({ query: "test" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text) as unknown;
    expect(parsed).toHaveProperty("workflows");
  });

  it("Test 16: search_workflows with scope 'mcp:read' is allowed (not denied)", async () => {
    const result = (await invokeSearchWorkflows(
      { query: "test" },
      "mcp:read"
    )) as { content: Array<{ type: string; text: string }> };
    const text = result.content[0].text;
    const parsed = JSON.parse(text) as { error?: string };
    expect(parsed.error).not.toBe("Forbidden");
  });
});

// ---------------------------------------------------------------------------
// call_workflow behavior tests
// ---------------------------------------------------------------------------

describe("call_workflow tool behavior", () => {
  const BASE_URL = "http://localhost:3000";
  const AUTH = "Bearer tok";

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (_key: string) => "application/json",
        },
        json: async () => ({ executionId: "exec-1", status: "running" }),
        text: async () => "",
      })
    );
  });

  async function invokeCallWorkflow(
    args: Record<string, unknown>,
    scope?: string
  ) {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, BASE_URL, AUTH, scope);
    const tool = registeredTools.find((t) => t.name === "call_workflow");
    if (!tool) {
      throw new Error("call_workflow not registered");
    }
    return tool.handler(args);
  }

  it("Test 17: call_workflow forwards slug to POST /api/mcp/workflows/{slug}/call", async () => {
    await invokeCallWorkflow({
      slug: "my-workflow",
      inputs: { amount: "100" },
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/mcp/workflows/my-workflow/call");
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.method).toBe("POST");
  });

  it("Test 18: call_workflow uses slug directly without org prefix", async () => {
    await invokeCallWorkflow({
      slug: "usdc-transfer",
      inputs: {},
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/mcp/workflows/usdc-transfer/call");
    expect(calledUrl).not.toContain("?org=");
  });

  it("Test 19: call_workflow sends inputs as POST body", async () => {
    const inputs = { amount: "50", recipient: "0xABC" };
    await invokeCallWorkflow({
      slug: "my-workflow",
      inputs,
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.amount).toBe("50");
    expect(body.recipient).toBe("0xABC");
  });

  it("Test 20: call_workflow returns content text with JSON response", async () => {
    const result = (await invokeCallWorkflow({
      slug: "my-workflow",
      inputs: {},
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text) as {
      executionId: string;
    };
    expect(parsed.executionId).toBe("exec-1");
  });

  it("Test 21: call_workflow for write workflow returns calldata response from call route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (_key: string) => "application/json",
        },
        json: async () => ({
          type: "calldata",
          to: "0xCONTRACT",
          data: "0xABCDEF",
          value: "0",
        }),
        text: async () => "",
      })
    );
    const result = (await invokeCallWorkflow({
      slug: "write-workflow",
      inputs: { recipient: "0xABC" },
    })) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text) as {
      type: string;
      to: string;
    };
    expect(parsed.type).toBe("calldata");
    expect(parsed.to).toBe("0xCONTRACT");
  });

  it("Test 22: call_workflow with scope 'mcp:write' is allowed", async () => {
    const result = (await invokeCallWorkflow(
      { slug: "my-workflow", inputs: {} },
      "mcp:write"
    )) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { error?: string };
    expect(parsed.error).not.toBe("Forbidden");
  });

  // KEEP-393: paid workflows return HTTP 402 with an x402 challenge body.
  // Previously the tool surfaced the raw `API call failed: 402 ...` message
  // and left agents to figure out how to pay. The augmented error now
  // names the price + chain + asset and lists the three concrete auto-pay
  // paths (paymentSigner.fetch, mcp__agentcash__fetch, marketplace UI).
  describe("Test 23.5: call_workflow 402 augmentation (KEEP-393)", () => {
    function mockFetch402(challengeBody: string): void {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 402,
          statusText: "Payment Required",
          headers: {
            get: (_key: string) => "application/json",
          },
          json: async () => JSON.parse(challengeBody),
          text: async () => challengeBody,
        })
      );
    }

    it("augments 402 error with parsed price, chain, asset, and 3 retry paths", async () => {
      const challenge = JSON.stringify({
        x402Version: 2,
        error: "Payment required",
        resource: { url: "https://app/api/mcp/workflows/yield-cmp/call" },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "50000",
            payTo: "0x52a93213b2748c8121691110ffb1c9389bd22308",
          },
        ],
      });
      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(SLUG_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(AMOUNT_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(NETWORK_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(PAYMENT_SIGNER_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(AGENTCASH_RE);
    });

    it("falls back to generic hint when 402 body is unparseable", async () => {
      mockFetch402("<html>402</html>");
      // Match the fallback line that appears regardless of body shape.
      await expect(
        invokeCallWorkflow({ slug: "weird", inputs: {} })
      ).rejects.toThrow(PAID_WEIRD_RE);

      mockFetch402("<html>402</html>");
      await expect(
        invokeCallWorkflow({ slug: "weird", inputs: {} })
      ).rejects.toThrow(PAYMENT_SIGNER_RE);
    });

    it("preserves the original 'API call failed: 402' prefix for callers that pattern-match", async () => {
      // The augmentation is purely additive — the original error message
      // appears unchanged at the start, so callers that grep for the
      // status line continue to work.
      mockFetch402(JSON.stringify({ x402Version: 2, accepts: [] }));
      await expect(
        invokeCallWorkflow({ slug: "preserved", inputs: {} })
      ).rejects.toThrow(API_402_PREFIX_RE);
    });

    it("does NOT augment non-402 errors (e.g. 500)", async () => {
      // 5xx and other failures stay verbatim — only 402 carries the
      // payment-retry semantics worth annotating.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: { get: (_k: string) => "application/json" },
          json: async () => ({ error: "boom" }),
          text: async () => "boom",
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "explode", inputs: {} })
      ).rejects.toThrow(API_500_RE);
      // Augmentation strings must NOT leak into 5xx errors.
      try {
        await invokeCallWorkflow({ slug: "explode", inputs: {} });
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain("paymentSigner.fetch");
        expect(msg).not.toContain("Paid workflow");
      }
    });
  });

  it("Test 23: call_workflow with scope 'mcp:read' is denied", async () => {
    const result = (await invokeCallWorkflow(
      { slug: "my-workflow", inputs: {} },
      "mcp:read"
    )) as {
      content: Array<{ type: string; text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text) as { error?: string };
    expect(parsed.error).toBe("Forbidden");
  });

  it("Test 24: call_workflow encodes slug in URL", async () => {
    await invokeCallWorkflow({
      slug: "my workflow+special",
      inputs: {},
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(
      "/api/mcp/workflows/my%20workflow%2Bspecial/call"
    );
  });
});

// ---------------------------------------------------------------------------
// call route: write workflow detection tests
// ---------------------------------------------------------------------------

describe("POST /api/mcp/workflows/[slug]/call: write workflow returns calldata", () => {
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
    mockGenerateCalldata,
    mockAuthenticateApiKey,
    mockAuthenticateOAuthToken,
    mockBuildCallCompletionResponse,
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
    mockGenerateCalldata: vi.fn(),
    mockAuthenticateApiKey: vi.fn(),
    mockAuthenticateOAuthToken: vi.fn(),
    mockBuildCallCompletionResponse: vi.fn(),
  }));

  vi.mock("@/lib/db", () => ({
    db: {
      select: mockDbSelect,
      insert: mockDbInsert,
      update: mockDbUpdate,
    },
  }));

  vi.mock("@/lib/api-key-auth", () => ({
    authenticateApiKey: mockAuthenticateApiKey,
  }));

  vi.mock("@/lib/mcp/oauth-auth", () => ({
    authenticateOAuthToken: mockAuthenticateOAuthToken,
  }));

  vi.mock("@/lib/db/schema", () => ({
    workflows: {
      id: "id",
      listedSlug: "listed_slug",
      isListed: "is_listed",
      tagId: "tag_id",
    },
    workflowExecutions: { id: "id" },
    tags: { id: "id", name: "name" },
  }));

  vi.mock("@/lib/payments/x402/server", () => ({
    server: { register: vi.fn() },
  }));

  vi.mock("@/lib/payments/x402/payment-gate", () => ({
    buildPaymentConfig: mockBuildPaymentConfig,
    hashPaymentSignature: mockHashPaymentSignature,
    findExistingPayment: mockFindExistingPayment,
    recordPayment: mockRecordPayment,
    resolveCreatorWallet: mockResolveCreatorWallet,
    extractPayerAddress: mockExtractPayerAddress,
  }));

  vi.mock("@/lib/payments/x402/reconcile", () => ({
    isTimeoutError: vi.fn().mockReturnValue(false),
    pollForPaymentConfirmation: vi.fn().mockResolvedValue(false),
  }));

  vi.mock("@x402/next", () => ({
    withX402: mockWithX402,
  }));

  vi.mock("workflow/api", () => ({
    start: mockStart,
  }));

  vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
    executeWorkflow: mockExecuteWorkflow,
  }));

  vi.mock("@/lib/billing/execution-guard", () => ({
    enforceExecutionLimit: mockEnforceExecutionLimit,
    EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  }));

  vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
    checkConcurrencyLimit: mockCheckConcurrencyLimit,
  }));

  vi.mock("@/lib/payments/x402/execution-wait", () => ({
    buildCallCompletionResponse: mockBuildCallCompletionResponse,
  }));

  vi.mock("@/lib/logging", () => ({
    ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
    logSystemError: mockLogSystemError,
  }));

  vi.mock("@/lib/mcp/calldata", () => ({
    generateCalldataForWorkflow: mockGenerateCalldata,
  }));

  const WRITE_WORKFLOW = {
    id: "wf-write-1",
    name: "Write Workflow",
    description: "A write workflow",
    organizationId: "org-1",
    listedSlug: "write-workflow",
    inputSchema: null,
    outputMapping: null,
    priceUsdcPerCall: "0",
    isListed: true,
    workflowType: "write",
    nodes: [
      {
        data: {
          actionType: "write-contract",
          config: {
            contractAddress: "0xCONTRACT",
            abi: '[{"name":"transfer","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}],"stateMutability":"nonpayable"}]',
            abiFunction: "transfer",
            functionArgs: '["0xRECIPIENT", "1000"]',
          },
        },
      },
    ],
    edges: [],
    userId: "user-1",
  };

  function setupDbSelectWorkflow(row: unknown) {
    // lookupWorkflow joins the tags table to project tagName into the row;
    // the real chain is select().from().leftJoin().where().limit(). Mirror
    // that shape here or the real code throws on the missing .leftJoin().
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(row ? [row] : []),
          }),
        }),
      }),
    });
  }

  function makeWriteRequest(
    slug: string,
    body: Record<string, unknown> = {}
  ): Request {
    return new Request(`http://localhost/api/mcp/workflows/${slug}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

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
    mockResolveCreatorWallet.mockResolvedValue("0xCREATOR");
    mockGenerateCalldata.mockReturnValue({
      success: true,
      to: "0xCONTRACT",
      data: "0xABCDEF",
      value: "0",
    });
    mockExtractPayerAddress.mockReturnValue(null);
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    // Default: completion wait times out so we fall back to running response.
    mockBuildCallCompletionResponse.mockImplementation((executionId: string) =>
      Promise.resolve({ executionId, status: "running" })
    );
    // Default: caller is authenticated. The write workflow path requires
    // an API key or MCP OAuth token, same as the free read path.
    mockAuthenticateOAuthToken.mockResolvedValue({
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

  it("Test 26: write workflow returns {type: 'calldata', to, data, value} instead of executing", async () => {
    setupDbSelectWorkflow(WRITE_WORKFLOW);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeWriteRequest("write-workflow");
    const params = Promise.resolve({ slug: "write-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.type).toBe("calldata");
    expect(body.to).toBe("0xCONTRACT");
    expect(body.data).toBe("0xABCDEF");
    expect(body.value).toBe("0");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("Test 27: write workflow with calldata generation failure returns 400", async () => {
    setupDbSelectWorkflow(WRITE_WORKFLOW);
    mockGenerateCalldata.mockReturnValue({
      success: false,
      error: "No write action node found in workflow",
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeWriteRequest("write-workflow");
    const params = Promise.resolve({ slug: "write-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("No write action node");
  });

  it("Test 28: read workflow (workflowType='read') still executes normally", async () => {
    const READ_WORKFLOW = {
      id: "wf-read-1",
      name: "Read Workflow",
      description: null,
      organizationId: "org-1",
      listedSlug: "read-workflow",
      inputSchema: null,
      outputMapping: null,
      priceUsdcPerCall: "0",
      isListed: true,
      workflowType: "read",
      nodes: [],
      edges: [],
      userId: "user-1",
    };
    setupDbSelectWorkflow(READ_WORKFLOW);
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "exec-read-1" }]),
      }),
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeWriteRequest("read-workflow");
    const params = Promise.resolve({ slug: "read-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-read-1");
    expect(body.status).toBe("running");
    expect(mockStart).toHaveBeenCalled();
    expect(mockGenerateCalldata).not.toHaveBeenCalled();
  });
});
