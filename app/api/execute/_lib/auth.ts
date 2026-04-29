import "server-only";

import { authenticateApiKey } from "@/lib/api-key-auth";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";

export type ApiKeyContext = {
  organizationId: string;
  apiKeyId: string;
};

/**
 * Validates a request for the direct execution API.
 * Accepts MCP OAuth tokens or API keys (kh_).
 * Returns the org context if valid, null otherwise.
 */
export async function validateApiKey(
  request: Request
): Promise<ApiKeyContext | null> {
  const oauthResult = await authenticateOAuthToken(request);
  if (oauthResult.authenticated && oauthResult.organizationId) {
    return {
      organizationId: oauthResult.organizationId,
      apiKeyId: `oauth:${oauthResult.userId ?? "unknown"}`,
    };
  }

  const result = await authenticateApiKey(request);

  if (!result.authenticated) {
    return null;
  }

  if (!(result.organizationId && result.apiKeyId)) {
    return null;
  }

  return {
    organizationId: result.organizationId,
    apiKeyId: result.apiKeyId,
  };
}
