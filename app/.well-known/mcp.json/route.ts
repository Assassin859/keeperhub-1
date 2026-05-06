// Static MCP server card. Lets ERC-8004 indexers (e.g. 8004scan) discover
// the tool catalog without performing an authenticated tools/list call.

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

const TOOLS = [
  "list_workflows",
  "get_workflow",
  "search_workflows",
  "search_plugins",
  "get_plugin",
  "list_integrations",
  "get_wallet_integration",
  "search_templates",
  "get_template",
  "deploy_template",
  "list_action_schemas",
  "search_protocol_actions",
  "ai_generate_workflow",
  "create_workflow",
  "update_workflow",
  "delete_workflow",
  "execute_workflow",
  "get_execution_status",
  "get_execution_logs",
  "execute_transfer",
  "execute_contract_call",
  "execute_check_and_execute",
  "execute_protocol_action",
  "get_direct_execution_status",
  "call_workflow",
  "list_workflow",
  "unlist_workflow",
  "update_workflow_listing",
  "get_workflow_listing",
  "tools_documentation",
] as const;

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const card = {
    $schema:
      "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    schema_version: "2025-06-18",
    version: "1.0.0",
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "keeperhub",
      title: "KeeperHub",
      version: "1.0.0",
    },
    description:
      "Web3 workflow automation platform. Build and deploy on-chain automations through a visual builder. Workflows are callable by AI agents via MCP and x402 micropayments.",
    iconUrl: `${baseUrl}/keeperhub_logo.png`,
    endpoint: `${baseUrl}/mcp`,
    transport: {
      type: "streamable-http",
      endpoint: "/mcp",
    },
    capabilities: { tools: {} },
    tools: TOOLS,
    authentication: {
      required: true,
      type: "oauth2",
      resource_metadata: `${baseUrl}/.well-known/oauth-protected-resource`,
    },
    erc8004: {
      agent_id: 31_875,
      chain: "ethereum",
      chain_id: 1,
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    },
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
