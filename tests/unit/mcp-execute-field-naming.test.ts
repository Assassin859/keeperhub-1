/**
 * KEEP-495: the MCP execution tools standardise their field names -
 * `chain_id` (was `network`) across all three, and `to_address`
 * (was `recipient_address`) on execute_transfer. The old names stay as
 * deprecated aliases for one release.
 *
 * Two layers of coverage:
 *   - Handler level: invokes the registered callback directly to pin the
 *     schema keys and the canonical-then-alias normalisation onto the route's
 *     camelCase body contract (`chainId`, `recipientAddress`).
 *   - SDK level: drives a real Client <-> McpServer over an in-memory transport
 *     so the MCP SDK's own Zod validation runs end to end - proving the renamed
 *     schema actually accepts new + deprecated payloads and still rejects a
 *     payload missing a required field.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type RegisteredTool = {
  name: string;
  schema: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
};

type FetchMock = ReturnType<typeof vi.fn>;

const VALIDATION_ERROR_PATTERN = /amount|Invalid arguments|validation/i;

let fetchMock: FetchMock;

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

// ---------------------------------------------------------------------------
// Handler level
// ---------------------------------------------------------------------------

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

function getTool(name: string): RegisteredTool {
  const { server, registeredTools } = makeMockServer();
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);
  const tool = registeredTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

describe("MCP execute tools field aliases - handler level (KEEP-495)", () => {
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

// ---------------------------------------------------------------------------
// SDK level - real Client <-> McpServer over an in-memory transport, so the
// MCP SDK's Zod validation runs the full tools/call path.
// ---------------------------------------------------------------------------

type ConnectedClient = { client: Client; close: () => Promise<void> };

async function connectedClient(): Promise<ConnectedClient> {
  const server = new McpServer({ name: "keep495-test", version: "0.0.0" });
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "keep495-test-client", version: "0.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolCallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

describe("MCP execute tools field aliases - SDK level (KEEP-495)", () => {
  it("accepts execute_transfer with canonical field names through SDK validation", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = (await client.callTool({
        name: "execute_transfer",
        arguments: { chain_id: "8453", to_address: "0xabc", amount: "0.1" },
      })) as ToolCallResult;

      expect(result.isError).toBeFalsy();
      const body = lastBody();
      expect(body.chainId).toBe("8453");
      expect(body.recipientAddress).toBe("0xabc");
    } finally {
      await close();
    }
  });

  it("accepts execute_transfer with deprecated aliases through SDK validation", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = (await client.callTool({
        name: "execute_transfer",
        arguments: { network: "1", recipient_address: "0xdef", amount: "0.2" },
      })) as ToolCallResult;

      expect(result.isError).toBeFalsy();
      const body = lastBody();
      expect(body.chainId).toBe("1");
      expect(body.recipientAddress).toBe("0xdef");
    } finally {
      await close();
    }
  });

  it("rejects execute_transfer when the required amount is missing (SDK schema runs)", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = (await client.callTool({
        name: "execute_transfer",
        arguments: { chain_id: "1", to_address: "0xabc" },
      })) as ToolCallResult;

      // The SDK surfaces a Zod validation failure as an error tool result
      // (isError: true) carrying the validation message, not a thrown
      // protocol error. Either way the request never reaches the handler.
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text ?? "").toMatch(VALIDATION_ERROR_PATTERN);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
