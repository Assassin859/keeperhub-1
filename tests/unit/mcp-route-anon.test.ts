import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that use them.
// ---------------------------------------------------------------------------

const { mockAuthenticate, mockGetSession, mockTouchSession } = vi.hoisted(
  () => ({
    mockAuthenticate: vi.fn(),
    mockGetSession: vi.fn(),
    mockTouchSession: vi.fn(),
  })
);

// Stub server-only so the route module can be imported in a test environment.
vi.mock("server-only", () => ({}));

// Mock authenticate path: the local `authenticate()` function in the route
// calls both authenticateApiKey and authenticateOAuthToken.
vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticate,
}));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: vi.fn().mockResolvedValue({ authenticated: false }),
}));

vi.mock("@/lib/mcp/logging", () => ({
  logMcpEvent: vi.fn(),
}));

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkMcpRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  startCleanupInterval: vi.fn(),
}));

vi.mock("@/lib/mcp/server", () => ({
  createMcpServer: vi.fn(),
}));

vi.mock("@/lib/mcp/session-token", () => ({
  createSessionToken: vi.fn(),
  verifySessionToken: vi.fn(),
  verifySessionTokenDetailed: vi.fn(),
}));

vi.mock("@/lib/mcp/sessions", () => ({
  deleteSession: vi.fn(),
  getSession: mockGetSession,
  setSession: vi.fn(),
  startCleanupInterval: vi.fn(),
  touchSession: mockTouchSession,
}));

vi.mock("@/lib/mcp/event-store", () => ({
  McpEventStore: vi.fn(),
}));

// The SDK transport is only reached for authed requests, but we mock it to
// prevent module-load errors in the test environment.
vi.mock(
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  () => ({
    WebStandardStreamableHTTPServerTransport: vi.fn(),
  })
);

// ---------------------------------------------------------------------------
// Import route handlers after all mocks are registered.
// ---------------------------------------------------------------------------

import { DELETE, GET, POST } from "@/app/mcp/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNAUTHENTICATED: {
  authenticated: false;
  error: string;
  statusCode: number;
} = { authenticated: false, error: "Unauthorized", statusCode: 401 };

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
  body?: string
): Request {
  return new Request("http://localhost:3000/mcp", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /mcp — anonymous health probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(UNAUTHENTICATED);
  });

  it("returns 200 with server info when no mcp-session-id header is present", async () => {
    const request = makeRequest("GET");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.name).toBe("keeperhub");
    expect(json.protocol).toBe("mcp");
    expect(json.authentication.required).toBe(true);
  });

  it("returns 401 when mcp-session-id is present but no auth token is provided", async () => {
    const request = makeRequest("GET", { "mcp-session-id": "some-session-id" });
    const response = await GET(request);

    expect(response.status).toBe(401);
  });
});

describe("POST /mcp — anonymous initialize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(UNAUTHENTICATED);
  });

  it("returns 200 JSON-RPC envelope for initialize with no auth, echoing the request id", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    });
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(7);
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.serverInfo.name).toBe("keeperhub");
    expect(json.result.authentication.required).toBe(true);
  });

  it("returns 401 for tools/list with no auth (only initialize is anon-allowed)", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
    });
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 401 for malformed JSON body with no auth (no 500)", async () => {
    const request = makeRequest("POST", {}, "{ not valid json");
    const response = await POST(request);

    expect(response.status).toBe(401);
  });
});

describe("POST /mcp — authed session-resume forwards parsedBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      authenticated: true,
      organizationId: "org-1",
      apiKeyId: "key-1",
      scope: undefined,
    });
  });

  it("passes the parsed body through to transport.handleRequest, not the consumed stream", async () => {
    const handleRequest = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    mockGetSession.mockReturnValue({
      organizationId: "org-1",
      transport: { handleRequest },
    });

    const parsed = {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: {},
    };
    const request = makeRequest(
      "POST",
      { "mcp-session-id": "session-abc" },
      JSON.stringify(parsed)
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    const [, options] = handleRequest.mock.calls[0] as [
      Request,
      { parsedBody: unknown },
    ];
    expect(options).toEqual({ parsedBody: parsed });
  });

  it("returns 400 when an authed POST has a malformed body (cannot reach transport)", async () => {
    const handleRequest = vi.fn();
    mockGetSession.mockReturnValue({
      organizationId: "org-1",
      transport: { handleRequest },
    });

    const request = makeRequest(
      "POST",
      { "mcp-session-id": "session-abc" },
      "{ not json"
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(handleRequest).not.toHaveBeenCalled();
  });
});

describe("DELETE /mcp — always requires auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(UNAUTHENTICATED);
  });

  it("returns 401 when no auth token is provided", async () => {
    const request = makeRequest("DELETE", {
      "mcp-session-id": "some-session-id",
    });
    const response = await DELETE(request);

    expect(response.status).toBe(401);
  });
});
