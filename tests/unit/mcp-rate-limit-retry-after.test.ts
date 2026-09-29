import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("MCP callApi 429 Retry-After handling (#2633)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("surfaces Retry-After seconds in error message when 429 is encountered", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "30", "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const listTool = tools.find((t) => t.name === "list_executions");
    if (!listTool) {
      throw new Error("list_executions not registered");
    }

    await expect(listTool.handler({})).rejects.toThrow(/API call failed: 429/);
    await expect(listTool.handler({})).rejects.toThrow(/Retry-After: 30s/);
  });

  it("handles 429 gracefully when Retry-After header is omitted without fabricated wait", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const listTool = tools.find((t) => t.name === "list_executions");
    if (!listTool) {
      throw new Error("list_executions not registered");
    }

    await expect(listTool.handler({})).rejects.toThrow(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
    await expect(listTool.handler({})).rejects.not.toThrow(/Retry-After/);
  });

  it("handles unparseable Retry-After header without fabricating a default wait duration", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "Retry-After": "not-a-number-or-date",
          "content-type": "application/json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const listTool = tools.find((t) => t.name === "list_executions");
    if (!listTool) {
      throw new Error("list_executions not registered");
    }

    await expect(listTool.handler({})).rejects.toThrow(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
    await expect(listTool.handler({})).rejects.not.toThrow(/Retry-After/);
  });

  it("surfaces Retry-After: 0s when header is 0", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "0", "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const listTool = tools.find((t) => t.name === "list_executions");
    if (!listTool) {
      throw new Error("list_executions not registered");
    }

    await expect(listTool.handler({})).rejects.toThrow(/Retry-After: 0s/);
  });

  it("leaves non-429 error messages untouched", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, tools } = makeMockServer();
    const { registerTools } = await import("@/lib/mcp/tools");
    registerTools(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );
    const listTool = tools.find((t) => t.name === "list_executions");
    if (!listTool) {
      throw new Error("list_executions not registered");
    }

    await expect(listTool.handler({})).rejects.toThrow(
      "API call failed: 500 Internal Server Error - Internal Server Error"
    );
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses valid integer seconds", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/tools");
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds("0")).toBe(0);
  });

  it("rounds up fractional seconds", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/tools");
    expect(parseRetryAfterSeconds("2.4")).toBe(3);
  });

  it("returns null for null, undefined, or empty header", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/tools");
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds("")).toBeNull();
  });

  it("returns null for unparseable strings without fabricating defaults", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/tools");
    expect(parseRetryAfterSeconds("invalid-duration")).toBeNull();
    expect(parseRetryAfterSeconds("-5")).toBeNull();
  });

  it("parses valid HTTP-date strings into future delta seconds", async () => {
    const { parseRetryAfterSeconds } = await import("@/lib/mcp/tools");
    const futureDate = new Date(Date.now() + 15_000).toUTCString();
    const result = parseRetryAfterSeconds(futureDate);
    expect(result).toBeGreaterThanOrEqual(14);
    expect(result).toBeLessThanOrEqual(16);
  });
});

describe("MCP server.ts fetchJson 429 Retry-After handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("surfaces Retry-After in error when resource fetch returns 429", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "45", "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, resources } = makeMockServer();
    const { registerResources } = await import("@/lib/mcp/server");
    registerResources(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );

    const workflowResource = resources.find((r) => r.name === "workflows-list");
    if (!workflowResource) {
      throw new Error("workflows-list resource not registered");
    }

    await expect(
      workflowResource.handler("keeperhub://workflows")
    ).rejects.toThrow(
      /API call failed: 429 Too Many Requests \(Retry-After: 45s\) - \{"error":"Rate limit exceeded"\}/
    );
  });

  it("omits Retry-After token when 429 response omits the header", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, resources } = makeMockServer();
    const { registerResources } = await import("@/lib/mcp/server");
    registerResources(
      server as unknown as McpServer,
      "http://localhost:3000",
      "Bearer test-token"
    );

    const workflowResource = resources.find((r) => r.name === "workflows-list");
    if (!workflowResource) {
      throw new Error("workflows-list resource not registered");
    }

    await expect(
      workflowResource.handler("keeperhub://workflows")
    ).rejects.toThrow(
      'API call failed: 429 Too Many Requests - {"error":"Rate limit exceeded"}'
    );
  });
});

type CapturedTool = {
  name: string;
  handler: (...args: unknown[]) => unknown;
};

type CapturedResource = {
  name: string;
  uri: string;
  handler: (...args: unknown[]) => unknown;
};

function makeMockServer(): {
  server: {
    tool: ReturnType<typeof vi.fn>;
    resource: ReturnType<typeof vi.fn>;
  };
  tools: CapturedTool[];
  resources: CapturedResource[];
} {
  const tools: CapturedTool[] = [];
  const resources: CapturedResource[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        _options: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        tools.push({ name, handler });
      }
    ),
    resource: vi.fn(
      (
        name: string,
        uri: string,
        _options: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        resources.push({ name, uri, handler });
      }
    ),
  };
  return { server, tools, resources };
}
