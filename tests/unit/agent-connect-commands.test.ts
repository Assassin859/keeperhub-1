import { describe, expect, it } from "vitest";
import { getAgentFrameworks } from "@/lib/agent-connect-commands";

const MCP_URL = "https://app.keeperhub.com/mcp";
const BROWSER_RE = /browser/i;

describe("getAgentFrameworks", () => {
  it("returns the supported frameworks in order", () => {
    const ids = getAgentFrameworks(MCP_URL, null).map((f) => f.id);
    expect(ids).toEqual(["claude-code", "cursor", "codex", "other"]);
  });

  it("interpolates the MCP url into every framework snippet", () => {
    for (const framework of getAgentFrameworks(MCP_URL, null)) {
      const bodies = framework.snippets.map((s) => s.body).join("\n");
      expect(bodies).toContain(MCP_URL);
    }
  });

  it("uses a key placeholder and highlights browser sign-in when no key", () => {
    const [claude] = getAgentFrameworks(MCP_URL, null);
    const body = claude.snippets[0].body;
    expect(body).toContain("kh_your_org_api_key");
    expect(body).not.toContain("kh_live_");
    expect(claude.note).toMatch(BROWSER_RE);
  });

  it("interpolates the real key when provided", () => {
    const key = "kh_live_abc123";
    const frameworks = getAgentFrameworks(MCP_URL, key);
    for (const framework of frameworks) {
      const bodies = framework.snippets.map((s) => s.body).join("\n");
      expect(bodies).toContain(`Bearer ${key}`);
      expect(bodies).not.toContain("kh_your_org_api_key");
    }
    expect(frameworks[0].note).not.toMatch(BROWSER_RE);
  });

  it("emits the Authorization header for the Claude Code command", () => {
    const [claude] = getAgentFrameworks(MCP_URL, "kh_live_xyz");
    expect(claude.snippets[0].body).toContain(
      "claude mcp add --transport http keeperhub"
    );
    expect(claude.snippets[0].body).toContain(
      "Authorization: Bearer kh_live_xyz"
    );
  });
});
