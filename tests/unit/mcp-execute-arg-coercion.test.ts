/**
 * #1841: the direct-execution tools take numeric arguments as strings, and
 * `function_args` as a JSON array that has itself been stringified. That is
 * correct on the wire, but it is not the first thing a client emits, and the
 * rejections arrive one field at a time on the first call anyone makes after
 * the handshake.
 *
 * The schema already publishes `"type": "string"` for every one of these
 * fields, so this is not a typing gap - it is that the natural first guess was
 * refused when it could have been accepted. These tests pin both halves of the
 * fix:
 *
 *   - a number where a decimal string is wanted, and an array/object where its
 *     JSON encoding is wanted, are accepted and normalised before the handler,
 *     so the REST body downstream is byte-identical to the hand-encoded call;
 *   - the published schema still says `string`, because the coercion is a
 *     fallback for the first guess rather than a second supported encoding;
 *   - input that is genuinely wrong (a boolean chain id) is still rejected, so
 *     the fallback did not become "validation off".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { registerTools } from "@/lib/mcp/tools";

type FetchMock = ReturnType<typeof vi.fn>;
type ToolCallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

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

type ConnectedClient = { client: Client; close: () => Promise<void> };

async function connectedClient(): Promise<ConnectedClient> {
  const server = new McpServer({ name: "coercion-test", version: "0.0.0" });
  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_WRITE);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "coercion-test-client", version: "0.0.0" });

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

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const { client, close } = await connectedClient();
  try {
    return (await client.callTool({
      name,
      arguments: args,
    })) as ToolCallResult;
  } finally {
    await close();
  }
}

describe("MCP execute tools accept the natural first-guess encoding (#1841)", () => {
  it("execute_transfer takes a numeric chain_id and amount, and forwards strings", async () => {
    const result = await callTool("execute_transfer", {
      chain_id: 11_155_111,
      to_address: "0xabc",
      amount: 0.1,
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.chainId).toBe("11155111");
    expect(body.amount).toBe("0.1");
  });

  it("execute_contract_call takes a real array for function_args and forwards its JSON encoding", async () => {
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: 11_155_111,
      function_name: "transfer",
      function_args: ["0xdef", "1000"],
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.chainId).toBe("11155111");
    expect(body.functionArgs).toBe('["0xdef","1000"]');
  });

  it("execute_contract_call takes numeric gas_limit_multiplier, value and priority_fee_gwei", async () => {
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: "11155111",
      function_name: "deposit",
      gas_limit_multiplier: 1.5,
      value: 0.25,
      priority_fee_gwei: 2,
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.gasLimitMultiplier).toBe("1.5");
    expect(body.value).toBe("0.25");
    expect(body.priorityFeeGwei).toBe("2");
  });

  it("execute_contract_call takes an ABI array and forwards its JSON encoding", async () => {
    const abi = [{ name: "transfer", type: "function", inputs: [] }];
    const result = await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: "1",
      function_name: "transfer",
      abi,
    });

    expect(result.isError).toBeFalsy();
    expect(lastBody().abi).toBe(JSON.stringify(abi));
  });

  it("execute_check_and_execute coerces the nested condition value and action fields", async () => {
    const result = await callTool("execute_check_and_execute", {
      contract_address: "0xc",
      chain_id: 42_161,
      function_name: "balanceOf",
      function_args: ["0xholder"],
      condition: { operator: "gt", value: 1000 },
      action: {
        contract_address: "0xa",
        function_name: "withdraw",
        function_args: [],
        gas_limit_multiplier: 2,
      },
    });

    expect(result.isError).toBeFalsy();
    const body = lastBody();
    expect(body.chainId).toBe("42161");
    expect(body.functionArgs).toBe('["0xholder"]');
    expect((body.condition as { value: unknown }).value).toBe("1000");
    const action = body.action as Record<string, unknown>;
    expect(action.functionArgs).toBe("[]");
    expect(action.gasLimitMultiplier).toBe("2");
  });

  it("the hand-encoded call is unchanged - same body as the coerced one", async () => {
    await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: "11155111",
      function_name: "transfer",
      function_args: '["0xdef","1000"]',
      gas_limit_multiplier: "1.5",
    });
    const encodedByHand = lastBody();

    await callTool("execute_contract_call", {
      contract_address: "0xc",
      chain_id: 11_155_111,
      function_name: "transfer",
      function_args: ["0xdef", "1000"],
      gas_limit_multiplier: 1.5,
    });

    expect(lastBody()).toEqual(encodedByHand);
  });

  it("still rejects an argument that is neither the string nor its natural guess", async () => {
    const result = await callTool("execute_transfer", {
      chain_id: true,
      to_address: "0xabc",
      amount: "0.1",
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes string types - the coercion is a fallback, not a second encoding", async () => {
    const { client, close } = await connectedClient();
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === "execute_contract_call");
      if (!tool) {
        throw new Error("execute_contract_call is not exposed");
      }
      const { properties } = tool.inputSchema as {
        properties: Record<string, { type?: string }>;
      };

      for (const field of [
        "chain_id",
        "function_args",
        "abi",
        "value",
        "gas_limit_multiplier",
        "priority_fee_gwei",
      ]) {
        expect(properties[field]?.type).toBe("string");
      }
    } finally {
      await close();
    }
  });
});
