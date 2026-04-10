export const SCOPE_MCP_READ = "mcp:read";
export const SCOPE_MCP_WRITE = "mcp:write";
export const SCOPE_MCP_ADMIN = "mcp:admin";

export const SUPPORTED_SCOPES = [
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
  SCOPE_MCP_ADMIN,
] as const;

export type OAuthScope = (typeof SUPPORTED_SCOPES)[number];

const READ_TOOLS = new Set<string>([
  "list_workflows",
  "get_workflow",
  "get_execution_status",
  "get_execution_logs",
  "list_action_schemas",
  "search_plugins",
  "get_plugin",
  "list_integrations",
  "get_wallet_integration",
  "search_templates",
  "get_template",
  "tools_documentation",
  "search_protocol_actions",
  "get_direct_execution_status",
  "search_workflows",
]);

const WRITE_TOOLS = new Set<string>([
  ...READ_TOOLS,
  "create_workflow",
  "update_workflow",
  "delete_workflow",
  "execute_workflow",
  "deploy_template",
  "ai_generate_workflow",
  "execute_protocol_action",
  "execute_transfer",
  "execute_contract_call",
  "execute_check_and_execute",
  "call_workflow",
]);

export function isScopeValid(scope: string): boolean {
  return SUPPORTED_SCOPES.includes(scope as OAuthScope);
}

export function parseScopes(scopeString: string): string[] {
  return scopeString
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isToolAllowed(toolName: string, scopeString: string): boolean {
  const scopes = parseScopes(scopeString);

  if (scopes.includes(SCOPE_MCP_ADMIN)) {
    return true;
  }

  if (scopes.includes(SCOPE_MCP_WRITE) && WRITE_TOOLS.has(toolName)) {
    return true;
  }

  if (scopes.includes(SCOPE_MCP_READ) && READ_TOOLS.has(toolName)) {
    return true;
  }

  return false;
}

export function normalizeScope(requestedScope: string): string {
  const requested = parseScopes(requestedScope);
  const valid = requested.filter((s) => isScopeValid(s));
  return valid.length > 0 ? valid.join(" ") : SCOPE_MCP_READ;
}
