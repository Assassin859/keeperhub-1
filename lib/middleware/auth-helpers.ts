import { authenticateApiKey } from "@/lib/api-key-auth";
import { auth } from "@/lib/auth";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";
import { getOrgContext } from "@/lib/middleware/org-context";

export type DualAuthContext =
  | {
      userId: string | null;
      organizationId: string | null;
      authMethod: "oauth" | "api-key" | "session";
    }
  | { error: string; status: number };

/**
 * Check for MCP OAuth JWT token authentication.
 * These tokens are issued by the MCP OAuth flow and forwarded
 * by the MCP server when calling downstream API endpoints.
 */
async function resolveOAuthToken(
  request: Request
): Promise<{ userId: string | null; organizationId: string | null } | null> {
  const result = await authenticateOAuthToken(request);
  if (!result.authenticated) {
    return null;
  }
  return {
    userId: result.userId ?? null,
    organizationId: result.organizationId ?? null,
  };
}

/**
 * Resolves user and organization context from OAuth token, API key, or session auth.
 * For API key auth, userId is the key creator (if available).
 * API keys are hard-scoped to their creation org (no cross-org override).
 *
 * @param required - If true (default), returns 401 when no auth method succeeds.
 *   Set to false for routes that allow unauthenticated access (e.g. public workflows).
 */
export async function getDualAuthContext(
  request: Request,
  options?: { required?: boolean }
): Promise<DualAuthContext> {
  const required = options?.required ?? true;

  const oauthAuth = await resolveOAuthToken(request);
  if (oauthAuth) {
    return {
      ...oauthAuth,
      authMethod: "oauth",
    };
  }

  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    return resolveApiKeyContext(apiKeyAuth);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user && required) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!session?.user) {
    return { userId: null, organizationId: null, authMethod: "session" };
  }

  const orgContext = await getOrgContext();
  return {
    userId: session.user.id,
    organizationId: orgContext.organization?.id ?? null,
    authMethod: "session",
  };
}

function resolveApiKeyContext(apiKeyAuth: {
  organizationId?: string;
  userId?: string;
}): DualAuthContext {
  return {
    userId: apiKeyAuth.userId ?? null,
    organizationId: apiKeyAuth.organizationId ?? null,
    authMethod: "api-key",
  };
}

/**
 * Resolves the organization ID from OAuth, API key, or session.
 * Used by PATCH/DELETE routes that only need org-level authorization.
 */
export async function resolveOrganizationId(
  request: Request
): Promise<{ organizationId: string } | { error: string; status: number }> {
  const oauthAuth = await resolveOAuthToken(request);
  if (oauthAuth?.organizationId) {
    return { organizationId: oauthAuth.organizationId };
  }

  const apiKeyAuth = await authenticateApiKey(request);

  if (apiKeyAuth.authenticated) {
    const organizationId = apiKeyAuth.organizationId;
    if (!organizationId) {
      return { error: "No active organization", status: 400 };
    }
    return { organizationId };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const orgContext = await getOrgContext();
  const organizationId = orgContext.organization?.id;
  if (!organizationId) {
    return { error: "No active organization", status: 400 };
  }
  return { organizationId };
}

/**
 * Resolves both organization ID and user ID from either OAuth, API key, or session.
 * Used by POST routes that need to track the creator.
 */
export async function resolveCreatorContext(
  request: Request
): Promise<
  { organizationId: string; userId: string } | { error: string; status: number }
> {
  const oauthAuth = await resolveOAuthToken(request);
  if (oauthAuth) {
    return validateCreatorFields(oauthAuth.organizationId, oauthAuth.userId);
  }

  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    return validateCreatorFields(
      apiKeyAuth.organizationId ?? null,
      apiKeyAuth.userId ?? null
    );
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const context = await getOrgContext();
  const organizationId = context.organization?.id ?? null;
  if (!organizationId) {
    return { error: "No active organization", status: 400 };
  }
  return { organizationId, userId: session.user.id };
}

function validateCreatorFields(
  organizationId: string | null | undefined,
  userId: string | null | undefined
):
  | { organizationId: string; userId: string }
  | { error: string; status: number } {
  if (!organizationId) {
    return { error: "No active organization", status: 400 };
  }
  if (!userId) {
    return {
      error: "Auth context missing user. Please recreate the API key.",
      status: 400,
    };
  }
  return { organizationId, userId };
}
