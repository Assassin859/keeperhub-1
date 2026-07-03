import { describe, expect, it } from "vitest";
import { getAgentFrameworks } from "@/lib/agent-connect-commands";

const MCP_URL = "https://app.keeperhub.com/mcp";

describe("getAgentFrameworks", () => {
  it("returns the supported frameworks in order", () => {
    const ids = getAgentFrameworks(MCP_URL).map((f) => f.id);
    expect(ids).toEqual([
      "claude-code",
      "claude-desktop",
      "openclaw",
      "codex",
      "gemini-cli",
      "goose",
      "other",
      "claude-plugin",
      "hermes",
      "eve",
    ]);
  });

  it("never embeds an API key or bearer header (OAuth only)", () => {
    for (const framework of getAgentFrameworks(MCP_URL)) {
      const bodies = framework.snippets.map((s) => s.body).join("\n");
      expect(bodies).not.toContain("Bearer");
      expect(bodies).not.toContain("Authorization");
      expect(bodies).not.toContain("kh_your_org_api_key");
    }
  });

  it("adds the Claude Code server over http with the MCP url", () => {
    const [claude] = getAgentFrameworks(MCP_URL);
    expect(claude.snippets[0].body).toBe(
      `claude mcp add --transport http keeperhub ${MCP_URL}`
    );
  });

  it("interpolates the MCP url into the config-based frameworks", () => {
    const byId = new Map(getAgentFrameworks(MCP_URL).map((f) => [f.id, f]));
    for (const id of [
      "claude-desktop",
      "openclaw",
      "codex",
      "gemini-cli",
      "goose",
      "other",
    ]) {
      expect(byId.get(id)?.snippets[0].body).toContain(MCP_URL);
    }
  });

  it("includes the plugin install commands", () => {
    const byId = new Map(getAgentFrameworks(MCP_URL).map((f) => [f.id, f]));
    expect(byId.get("claude-plugin")?.snippets[0].body).toContain(
      "/plugin marketplace add KeeperHub/claude-plugins"
    );
    expect(byId.get("hermes")?.snippets[0].body).toContain(
      "hermes plugins install KeeperHub/hermes-plugin --enable"
    );
  });
});
