import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_MCP_TOOLS,
  DEPRECATED_TOOL_ALIASES,
  getAuthenticatedToolsForDiscovery,
} from "@/lib/mcp/mcp-tool-catalog";

describe("mcp-tool-catalog", () => {
  it("includes get_execution and deprecated execution aliases", () => {
    expect(AUTHENTICATED_MCP_TOOLS).toContain("get_execution");
    expect(AUTHENTICATED_MCP_TOOLS).toContain("get_execution_logs");
    expect(AUTHENTICATED_MCP_TOOLS).toContain("get_execution_status");
    expect(DEPRECATED_TOOL_ALIASES.get_execution_logs).toBe("get_execution");
  });

  it("includes new PR2 agent tools", () => {
    for (const name of [
      "validate_cron",
      "list_executions",
      "get_spending_limits",
      "test_notification",
      "tempo_sign_and_hold",
      "tempo_cancel_hold",
      "tempo_release_hold",
    ]) {
      expect(AUTHENTICATED_MCP_TOOLS).toContain(name);
    }
  });

  it("getAuthenticatedToolsForDiscovery returns stable sorted copy", () => {
    const tools = getAuthenticatedToolsForDiscovery();
    expect(tools.length).toBe(AUTHENTICATED_MCP_TOOLS.length);
    expect([...tools].sort()).toEqual([...AUTHENTICATED_MCP_TOOLS].sort());
  });
});
