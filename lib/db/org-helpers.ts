/**
 * Helpers for resolving organization metadata used in error logs.
 */
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db";
import { organization, organizationSubscriptions } from "@/lib/db/schema";
import { enterWorkflowErrorContext } from "@/lib/workflow/executor/error-context";

/**
 * Resolve an organization's slug by id. Cached per request via React `cache()`
 * so multiple call sites in the same request share a single round-trip.
 */
export const getOrgSlug = cache(
  async (orgId: string | null | undefined): Promise<string | undefined> => {
    if (!orgId) {
      return undefined;
    }
    try {
      const rows = await db
        .select({ slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);
      return rows[0]?.slug ?? undefined;
    } catch {
      // Slug is best-effort metadata for log labels - never let a failed
      // lookup break the calling request.
      return undefined;
    }
  }
);

/**
 * Resolve an organization's display name by id. Cached per request. Same
 * best-effort semantics as `getOrgSlug` - used as a human-readable identifier
 * in error logs alongside `org_id`.
 */
export const getOrgName = cache(
  async (orgId: string | null | undefined): Promise<string | undefined> => {
    if (!orgId) {
      return undefined;
    }
    try {
      const rows = await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);
      return rows[0]?.name ?? undefined;
    } catch {
      return undefined;
    }
  }
);

/**
 * Resolve an organization's plan by id. Cached per request. Returns "free"
 * when the org has no subscription row, undefined when the lookup fails or
 * orgId is missing. Used as a low-cardinality label on error metrics so
 * alerts can filter to managed clients.
 */
export const getOrgPlanLabel = cache(
  async (orgId: string | null | undefined): Promise<string | undefined> => {
    if (!orgId) {
      return undefined;
    }
    try {
      const rows = await db
        .select({ plan: organizationSubscriptions.plan })
        .from(organizationSubscriptions)
        .where(eq(organizationSubscriptions.organizationId, orgId))
        .limit(1);
      return rows[0]?.plan ?? "free";
    } catch {
      return undefined;
    }
  }
);

/**
 * Convenience for direct-execute API routes (e.g.
 * /api/execute/check-and-execute) that bypass the workflow executor and
 * therefore don't get its ALS scope. Resolves the org slug and plan and
 * enters the workflow error context for the rest of the request.
 */
export async function enterApiExecuteErrorContext(
  organizationId: string | null | undefined
): Promise<void> {
  if (!organizationId) {
    return;
  }
  const [slug, plan] = await Promise.all([
    getOrgSlug(organizationId),
    getOrgPlanLabel(organizationId),
  ]);
  enterWorkflowErrorContext({
    org_id: organizationId,
    org_slug: slug,
    plan,
  });
}
