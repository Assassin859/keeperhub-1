import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type IntegrationVisibility,
  integrationGrants,
  integrations,
  users,
} from "@/lib/db/schema";
import { isUserMemberOfOrganization } from "@/lib/workflow/access";

/**
 * The identity whose grants gate credential use for a given execution.
 *
 * - Interactive executions: the authenticated caller.
 * - Owner-context executions (webhook, scheduler, internal, MCP/agent): the
 *   workflow owner. The caller's identity is not available once a run is
 *   dispatched, so owner-context authorization is the only check possible at
 *   runtime and is resolved up front at the execution entry point.
 */
export type IntegrationPrincipal = {
  userId: string | null;
  organizationId: string | null;
};

/** Minimal integration shape needed to make an authorization decision. */
export type IntegrationAuthRow = {
  id: string;
  userId: string;
  organizationId: string | null;
  visibility: IntegrationVisibility;
};

type AuthContext = {
  /** Owner of the integration is deactivated - credentials are frozen. */
  isOwnerDeactivated: boolean;
  /** Principal is a current member of its own organization. */
  isPrincipalMember: boolean;
  /** A specific_members grant exists for (integration, principal). */
  hasGrant: boolean;
};

/**
 * Pure authorization decision for a single (integration, principal) pair.
 * No I/O - the caller resolves the AuthContext via batched queries. Kept pure
 * so the rule table is unit-testable without a database.
 */
export function isIntegrationUsable(
  integration: IntegrationAuthRow,
  principal: IntegrationPrincipal,
  ctx: AuthContext
): boolean {
  // A deactivated owner's credentials are frozen for everyone, including
  // owner-context (scheduled/webhook) executions that would otherwise run as
  // the now-deactivated owner. This is the lazy deactivation cascade.
  if (ctx.isOwnerDeactivated) {
    return false;
  }

  // Owner may always use their own integration.
  if (principal.userId !== null && principal.userId === integration.userId) {
    return true;
  }

  switch (integration.visibility) {
    case "organization":
      return (
        integration.organizationId !== null &&
        integration.organizationId === principal.organizationId &&
        ctx.isPrincipalMember
      );
    case "specific_members":
      return ctx.hasGrant;
    default:
      // "private" - only the owner, handled above.
      return false;
  }
}

/**
 * Given a set of integration ids and the executing principal, return the
 * subset the principal is NOT authorized to use.
 *
 * Non-existent ids (e.g. deleted integrations) are treated as authorized -
 * stale references must stay savable and must not leak existence. All
 * context lookups (membership, grants, owner deactivation) are batched into a
 * single query each to avoid N+1.
 */
export async function filterUnauthorizedIntegrationIds(
  integrationIds: string[],
  principal: IntegrationPrincipal
): Promise<string[]> {
  if (integrationIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: integrations.id,
      userId: integrations.userId,
      organizationId: integrations.organizationId,
      visibility: integrations.visibility,
    })
    .from(integrations)
    .where(inArray(integrations.id, integrationIds));

  if (rows.length === 0) {
    return [];
  }

  const isPrincipalMember =
    principal.userId !== null && principal.organizationId !== null
      ? await isUserMemberOfOrganization(
          principal.userId,
          principal.organizationId
        )
      : false;

  const grantedIds = new Set<string>();
  if (principal.userId !== null) {
    const grantRows = await db
      .select({ integrationId: integrationGrants.integrationId })
      .from(integrationGrants)
      .where(
        and(
          inArray(integrationGrants.integrationId, integrationIds),
          eq(integrationGrants.userId, principal.userId)
        )
      );
    for (const grant of grantRows) {
      grantedIds.add(grant.integrationId);
    }
  }

  const ownerIds = [...new Set(rows.map((row) => row.userId))];
  const deactivatedOwners = new Set<string>();
  const deactivatedRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ownerIds), isNotNull(users.deactivatedAt)));
  for (const user of deactivatedRows) {
    deactivatedOwners.add(user.id);
  }

  const unauthorized: string[] = [];
  for (const row of rows) {
    const usable = isIntegrationUsable(row, principal, {
      isOwnerDeactivated: deactivatedOwners.has(row.userId),
      isPrincipalMember,
      hasGrant: grantedIds.has(row.id),
    });
    if (!usable) {
      unauthorized.push(row.id);
    }
  }
  return unauthorized;
}
