import { and, eq } from "drizzle-orm";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { getOrgContext } from "@/lib/middleware/org-context";

export type DualAuthContext =
  | { userId: string | null; organizationId: string | null }
  | { error: string; status: number };

/**
 * Resolves user and organization context from either API key or session auth.
 * For API key auth, userId is the key creator (if available).
 *
 * @param required - If true (default), returns 401 when neither auth method succeeds.
 *   Set to false for routes that allow unauthenticated access (e.g. public workflows).
 */
export async function getDualAuthContext(
  request: Request,
  options?: { required?: boolean }
): Promise<DualAuthContext> {
  const required = options?.required ?? true;

  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    const defaultOrgId = apiKeyAuth.organizationId || null;
    const userId = apiKeyAuth.userId || null;

    // Check for X-Organization-Id override
    if (defaultOrgId) {
      const overrideResult = await resolveOrganizationOverride(
        request,
        defaultOrgId,
        userId
      );
      if ("error" in overrideResult) {
        return { error: overrideResult.error, status: overrideResult.status };
      }
      return { userId, organizationId: overrideResult.organizationId };
    }

    return { userId, organizationId: defaultOrgId };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    if (required) {
      return { error: "Unauthorized", status: 401 };
    }
    return { userId: null, organizationId: null };
  }

  const orgContext = await getOrgContext();
  return {
    userId: session.user.id,
    organizationId: orgContext.organization?.id || null,
  };
}

/**
 * Resolves the organization ID from either an API key or session.
 * Used by PATCH/DELETE routes that only need org-level authorization.
 */
export async function resolveOrganizationId(
  request: Request
): Promise<{ organizationId: string } | { error: string; status: number }> {
  const apiKeyAuth = await authenticateApiKey(request);

  if (apiKeyAuth.authenticated) {
    const defaultOrgId = apiKeyAuth.organizationId;
    if (!defaultOrgId) {
      return { error: "No active organization", status: 400 };
    }

    const overrideResult = await resolveOrganizationOverride(
      request,
      defaultOrgId,
      apiKeyAuth.userId || null
    );
    if ("error" in overrideResult) {
      return { error: overrideResult.error, status: overrideResult.status };
    }
    return { organizationId: overrideResult.organizationId };
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
 * Resolves both organization ID and user ID from either an API key or session.
 * Used by POST routes that need to track the creator.
 */
export async function resolveCreatorContext(
  request: Request
): Promise<
  { organizationId: string; userId: string } | { error: string; status: number }
> {
  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    const defaultOrgId = apiKeyAuth.organizationId || null;
    const userId = apiKeyAuth.userId || null;
    if (!defaultOrgId) {
      return { error: "No active organization", status: 400 };
    }
    if (!userId) {
      return {
        error: "API key has no associated user. Please recreate the API key.",
        status: 400,
      };
    }

    const overrideResult = await resolveOrganizationOverride(
      request,
      defaultOrgId,
      userId
    );
    if ("error" in overrideResult) {
      return { error: overrideResult.error, status: overrideResult.status };
    }
    return { organizationId: overrideResult.organizationId, userId };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const context = await getOrgContext();
  const organizationId = context.organization?.id || null;
  if (!organizationId) {
    return { error: "No active organization", status: 400 };
  }
  return { organizationId, userId: session.user.id };
}

/**
 * Resolves an optional organization override from the X-Organization-Id header.
 * If the header is present, validates that the given userId is a member of
 * the target organization. Returns the override org ID if valid, or the
 * default org ID if no override is requested.
 *
 * @param request - The incoming HTTP request (checks X-Organization-Id header)
 * @param defaultOrgId - The organization ID from auth (API key or session)
 * @param userId - The user ID to verify membership for
 * @returns The resolved organization ID, or an error
 */
export async function resolveOrganizationOverride(
  request: Request,
  defaultOrgId: string,
  userId: string | null
): Promise<{ organizationId: string } | { error: string; status: number }> {
  const overrideOrgId = request.headers.get("x-organization-id");

  if (!overrideOrgId || overrideOrgId === defaultOrgId) {
    return { organizationId: defaultOrgId };
  }

  if (!userId) {
    return {
      error:
        "Organization override requires an API key with an associated user. Recreate the API key from the web app.",
      status: 400,
    };
  }

  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.organizationId, overrideOrgId), eq(member.userId, userId))
    )
    .limit(1);

  if (!membership) {
    return {
      error: `User is not a member of organization ${overrideOrgId}`,
      status: 403,
    };
  }

  return { organizationId: overrideOrgId };
}
