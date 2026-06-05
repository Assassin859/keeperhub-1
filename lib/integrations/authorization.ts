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
 * - Interactive callers (a user saving or browsing): `userId` set; org
 *   visibility additionally requires current membership.
 * - The ORG principal (`userId: null`, `organizationId` set): the workflow's
 *   owning organization itself. The org owns workflows, so every execution
 *   gate and the runtime credential fetch authorize as the org - a workflow
 *   uses its org's organization-visibility integrations regardless of who
 *   created it or who triggered the run. Private integrations and per-user
 *   specific_members grants do NOT resolve for the org principal.
 */
export type IntegrationPrincipal = {
  userId: string | null;
  organizationId: string | null;
};

/** Minimal integration shape needed to make an authorization decision. */
export type IntegrationAuthRow = {
  id: string;
  createdBy: string;
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
  // A deactivated creator's credentials are frozen for everyone, including
  // org-principal executions. The credential was contributed by that user;
  // deactivation (compromise/offboard) must freeze it even though the org
  // owns the workflows that reference it. This is the lazy deactivation
  // cascade.
  if (ctx.isOwnerDeactivated) {
    return false;
  }

  // Creator may always use their own integration (interactive callers).
  if (principal.userId !== null && principal.userId === integration.createdBy) {
    return true;
  }

  // The org principal (userId null, organizationId set) is the owning org
  // itself: it is entitled to its own organization-visibility integrations
  // without a per-user membership check, because there is no user - the org
  // was resolved from an authenticated context at the entry point.
  const isOrgPrincipal =
    principal.userId === null && principal.organizationId !== null;

  switch (integration.visibility) {
    case "organization":
      return (
        integration.organizationId !== null &&
        integration.organizationId === principal.organizationId &&
        (isOrgPrincipal || ctx.isPrincipalMember)
      );
    case "specific_members":
      return ctx.hasGrant;
    default:
      // "private" - only the creator, handled above.
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
      createdBy: integrations.createdBy,
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

  const creatorIds = [...new Set(rows.map((row) => row.createdBy))];
  const deactivatedOwners = new Set<string>();
  const deactivatedRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, creatorIds), isNotNull(users.deactivatedAt)));
  for (const user of deactivatedRows) {
    deactivatedOwners.add(user.id);
  }

  const unauthorized: string[] = [];
  for (const row of rows) {
    const usable = isIntegrationUsable(row, principal, {
      isOwnerDeactivated: deactivatedOwners.has(row.createdBy),
      isPrincipalMember,
      hasGrant: grantedIds.has(row.id),
    });
    if (!usable) {
      unauthorized.push(row.id);
    }
  }
  return unauthorized;
}
