/**
 * KEEP-483: scope-denied errors must tell clients which scope to request
 * on reauthorize. Previously a write tool on a read-only token returned
 * generic "Forbidden" so builders had no actionable signal.
 *
 * Tests `getRequiredScopeForTool` (the new public helper) and asserts the
 * full set of tool -> required-scope mappings so the contract doesn't
 * silently drift as new tools are added.
 */
import { describe, expect, it } from "vitest";
import {
  getRequiredScopeForTool,
  SCOPE_MCP_ADMIN,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
} from "@/lib/mcp/oauth-scopes";

describe("getRequiredScopeForTool (KEEP-483)", () => {
  it.each([
    "list_workflows",
    "get_workflow",
    "get_execution_status",
    "list_action_schemas",
    "search_plugins",
    "list_integrations",
  ])("returns mcp:read for read tool %s", (toolName) => {
    expect(getRequiredScopeForTool(toolName)).toBe(SCOPE_MCP_READ);
  });

  it.each([
    "create_workflow",
    "update_workflow",
    "delete_workflow",
    "execute_workflow",
    "deploy_template",
    "ai_generate_workflow",
    "execute_transfer",
    "execute_contract_call",
    "call_workflow",
    "list_workflow",
    "unlist_workflow",
  ])("returns mcp:write for write tool %s", (toolName) => {
    expect(getRequiredScopeForTool(toolName)).toBe(SCOPE_MCP_WRITE);
  });

  it("returns mcp:admin for unknown tools (fail closed)", () => {
    expect(getRequiredScopeForTool("not_a_real_tool")).toBe(SCOPE_MCP_ADMIN);
    expect(getRequiredScopeForTool("")).toBe(SCOPE_MCP_ADMIN);
  });

  it("read scope is sufficient for every read tool — clients know to request it", () => {
    // Sanity check: every tool that lives in READ_TOOLS should map to
    // mcp:read, not mcp:write. If a read tool ever needed write, the
    // Hydra-style "I have read, why does this 401" confusion comes back.
    const readToolSample = [
      "list_workflows",
      "get_workflow",
      "get_execution_logs",
      "search_workflows",
      "search_templates",
    ];
    for (const tool of readToolSample) {
      const required = getRequiredScopeForTool(tool);
      expect(required).not.toBe(SCOPE_MCP_WRITE);
      expect(required).not.toBe(SCOPE_MCP_ADMIN);
    }
  });
});
