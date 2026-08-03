import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("MCP callApi cold-start handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("create_workflow surfaces retry hint on 504 with Retry-After", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Gateway Timeout", {
        status: 504,
        headers: { "Retry-After": "45" },
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
    const createTool = tools.find((t) => t.name === "create_workflow");
    if (!createTool) {
      throw new Error("create_workflow not registered");
    }

    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
        idempotency_key: "idem-1",
      })
    ).rejects.toThrow(/upstream_cold_start/);

    await expect(
      createTool.handler({
        name: "Test",
        nodes: [],
        edges: [],
        idempotency_key: "idem-1",
      })
    ).rejects.toThrow(/45/);
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
