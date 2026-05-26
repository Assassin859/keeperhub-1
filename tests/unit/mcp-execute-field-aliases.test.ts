/**
 * KEEP-495: the MCP execution tools standardise their field names -
 * `chain_id` (was `network`) across all three, and `to_address`
 * (was `recipient_address`) on execute_transfer. The old names stay as
 * deprecated aliases for one release.
 *
 * These tests pin two things so the contract does not silently drift:
 *   1. The registered Zod schema exposes the canonical name AND keeps the
 *      deprecated alias.
 *   2. The handler normalises either name down to the route's existing
 *      camelCase body contract (`chainId`, `recipientAddress`), with the
 *      canonical field winning when both are sent.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type RegisteredTool = {
  name: string;
  schema: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
};

function makeMockServer(): {
  server: McpServer;
  registeredTools: RegisteredTool[];
} {
  const registeredTools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        schema: Record<string, unknown>,
        _annotations: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        registeredTools.push({ name, schema, handler });
      }
    ),
  } as unknown as McpServer;
  return { server, registeredTools };
}

type FetchMock = ReturnType<typeof vi.fn>;

function jsonOkResponse(body: Record<string, unknown>): unknown {
  return {
    ok: true,
    status: 202,
    statusText: "Accepted",
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  };
}

function getTool(name: string): RegisteredTool {
  const { server, registeredTools } = makeMockServer();
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);
  const tool = registeredTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

describe("MCP execute tools field aliases (KEEP-495)", () => {
  let fetchMock: FetchMock;

  function lastBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) {
      throw new Error("fetch was not called");
    }
    const init = call[1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  beforeEach(() => {
    fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonOkResponse({ executionId: "exec_1", status: "completed" })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // --- schema shape -------------------------------------------------------

  it("execute_transfer schema exposes canonical names and keeps deprecated aliases", () => {
    const keys = Object.keys(getTool("execute_transfer").schema);
    expect(keys).toContain("chain_id");
    expect(keys).toContain("to_address");
    expect(keys).toContain("network");
    expect(keys).toContain("recipient_address");
  });

  it("execute_contract_call and execute_check_and_execute expose chain_id with network alias", () => {
    for (const name of ["execute_contract_call", "execute_check_and_execute"]) {
      const keys = Object.keys(getTool(name).schema);
      expect(keys).toContain("chain_id");
      expect(keys).toContain("network");
    }
  });

  // --- execute_transfer handler normalisation -----------------------------

  it("execute_transfer: canonical names map to chainId + recipientAddress", async () => {
    await getTool("execute_transfer").handler({
      chain_id: "8453",
      to_address: "0xabc",
      amount: "0.1",
    });
    const body = lastBody();
    expect(body.chainId).toBe("8453");
    expect(body.recipientAddress).toBe("0xabc");
  });

  it("execute_transfer: deprecated aliases still resolve", async () => {
    await getTool("execute_transfer").handler({
      network: "1",
      recipient_address: "0xdef",
      amount: "0.2",
    });
    const body = lastBody();
    expect(body.chainId).toBe("1");
    expect(body.recipientAddress).toBe("0xdef");
  });

  it("execute_transfer: canonical name wins when both are sent", async () => {
    await getTool("execute_transfer").handler({
      chain_id: "8453",
      network: "1",
      to_address: "0xabc",
      recipient_address: "0xdef",
      amount: "0.1",
    });
    const body = lastBody();
    expect(body.chainId).toBe("8453");
    expect(body.recipientAddress).toBe("0xabc");
  });

  // --- execute_contract_call handler normalisation ------------------------

  it("execute_contract_call: chain_id and network both map to chainId", async () => {
    const tool = getTool("execute_contract_call");
    await tool.handler({
      contract_address: "0xc",
      chain_id: "10",
      function_name: "foo",
    });
    expect(lastBody().chainId).toBe("10");

    await tool.handler({
      contract_address: "0xc",
      network: "137",
      function_name: "foo",
    });
    expect(lastBody().chainId).toBe("137");
  });

  // --- execute_check_and_execute handler normalisation --------------------

  it("execute_check_and_execute: chain_id and network both map to chainId", async () => {
    const tool = getTool("execute_check_and_execute");
    const condition = { operator: "gt", value: "1000" };
    const action = { contract_address: "0xa", function_name: "bar" };

    await tool.handler({
      contract_address: "0xc",
      chain_id: "42161",
      function_name: "baz",
      condition,
      action,
    });
    expect(lastBody().chainId).toBe("42161");

    await tool.handler({
      contract_address: "0xc",
      network: "42161",
      function_name: "baz",
      condition,
      action,
    });
    expect(lastBody().chainId).toBe("42161");
  });
});
