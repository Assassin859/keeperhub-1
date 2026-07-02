// Per-framework setup snippets for connecting an AI agent / MCP client to
// KeeperHub. The canonical commands live in docs/ai-tools/mcp-server.md; this
// module is the single source the onboarding UI renders so the two do not
// drift. All frameworks target the same MCP endpoint ({origin}/mcp) and
// authenticate with either a browser OAuth flow (no key) or a `kh_` org API
// key passed as a Bearer header.

export type AgentSnippet = {
  // A caption shown above the code block (e.g. a filename or "Run this").
  caption: string;
  // The command or config body to copy.
  body: string;
};

export type AgentFramework = {
  id: string;
  label: string;
  snippets: AgentSnippet[];
  // Extra guidance shown under the snippets (e.g. the OAuth sign-in hint).
  note?: string;
};

const KEY_PLACEHOLDER = "kh_your_org_api_key";

function bearerLine(apiKey: string | null): string {
  return `Authorization: Bearer ${apiKey ?? KEY_PLACEHOLDER}`;
}

/**
 * Build the framework setup snippets for the given MCP endpoint. When an org
 * API key has been minted it is interpolated into the header variants;
 * otherwise a placeholder is shown and the browser-OAuth path is highlighted.
 */
export function getAgentFrameworks(
  mcpUrl: string,
  apiKey: string | null
): AgentFramework[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      snippets: [
        {
          caption: "Add the server",
          body: `claude mcp add --transport http keeperhub ${mcpUrl} \\
  --header "${bearerLine(apiKey)}"`,
        },
      ],
      note: apiKey
        ? "The key is already scoped to this organization. Run the command in your project, then use KeeperHub tools from Claude Code."
        : "Prefer browser sign-in? Add without the --header flag, then run /mcp in Claude Code and complete the sign-in when prompted.",
    },
    {
      id: "cursor",
      label: "Cursor",
      snippets: [
        {
          caption: ".cursor/mcp.json",
          body: `{
  "mcpServers": {
    "keeperhub": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${apiKey ?? KEY_PLACEHOLDER}" }
    }
  }
}`,
        },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      snippets: [
        {
          caption: "~/.codex/config.toml",
          body: `[mcp_servers.keeperhub]
url = "${mcpUrl}"
http_headers = { Authorization = "Bearer ${apiKey ?? KEY_PLACEHOLDER}" }`,
        },
      ],
    },
    {
      id: "other",
      label: "Other agents",
      snippets: [
        {
          caption: "mcpServers config (Windsurf, Cline, Continue, ...)",
          body: `{
  "mcpServers": {
    "keeperhub": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${apiKey ?? KEY_PLACEHOLDER}" }
    }
  }
}`,
        },
      ],
      note: "Any MCP-compatible client can connect to the same endpoint. See docs.keeperhub.com for per-tool guides.",
    },
  ];
}
