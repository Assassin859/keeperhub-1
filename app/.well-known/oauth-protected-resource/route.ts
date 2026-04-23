import {
  SCOPE_MCP_ADMIN,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
} from "@/lib/mcp/oauth-scopes";

export const dynamic = "force-dynamic";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// RFC 9728 Protected Resource Metadata. Claude Desktop and other strict
// MCP clients discover the authorization server via this document after
// receiving a 401 from /mcp with a WWW-Authenticate: Bearer resource_metadata=...
// header. Claude Code tolerates its absence; Claude Desktop does not.
export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const metadata = {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: [SCOPE_MCP_READ, SCOPE_MCP_WRITE, SCOPE_MCP_ADMIN],
    bearer_methods_supported: ["header"],
    resource_documentation: `${baseUrl}/mcp`,
  };
  return Response.json(metadata);
}
