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
  "get_execution",
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
  "validate_workflow",
  "prepare_test_pin_data",
  "get_workflow_listing",
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
  "list_workflow",
  "unlist_workflow",
  "update_workflow_listing",
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

/**
 * Return the minimum OAuth scope a caller needs to invoke the given tool.
 *
 * KEEP-483: when a tool denies for missing scope, the client must be told
 * which scope to request on reauthorize. Previously the MCP wrapper
 * returned a generic "Forbidden" so builders had no actionable signal —
 * the Hydra report observed write tools all denied with no clue that
 * `mcp:write` was the missing piece.
 */
export function getRequiredScopeForTool(toolName: string): OAuthScope {
  // READ_TOOLS is a strict subset of WRITE_TOOLS, so a tool present in
  // READ_TOOLS satisfies the read scope. Tools in WRITE_TOOLS only need
  // write. Anything else (unknown / admin-only) falls back to admin.
  if (READ_TOOLS.has(toolName)) {
    return SCOPE_MCP_READ;
  }
  if (WRITE_TOOLS.has(toolName)) {
    return SCOPE_MCP_WRITE;
  }
  return SCOPE_MCP_ADMIN;
}
