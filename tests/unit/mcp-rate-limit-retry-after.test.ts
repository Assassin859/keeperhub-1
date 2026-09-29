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
    await expect(listTool.handler({})).rejects.toThrow(/Retry-After: 30/);
  });

  it("handles 429 gracefully when Retry-After header is omitted", async () => {
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

    await expect(listTool.handler({})).rejects.toThrow(/API call failed: 429/);
  });
});

type CapturedTool = {
  name: string;
  handler: (...args: unknown[]) => unknown;
};

function makeMockServer(): {
  server: { tool: ReturnType<typeof vi.fn> };
  tools: CapturedTool[];
} {
  const tools: CapturedTool[] = [];
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
  };
  return { server, tools };
}
