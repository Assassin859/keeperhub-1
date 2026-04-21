import "server-only";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { type SafeWallet, safeWallets } from "@/lib/db/schema";
import { getActiveOrgId } from "@/lib/middleware/org-context";

export type AdminContext = {
  organizationId: string;
};

export type AdminError = {
  error: string;
  status: number;
};

/**
 * Authenticate the request, require an active organization, and require the
 * caller to be an admin or owner of that organization. Mirrors the gate used
 * by the Safe deploy endpoint so Safe policy management is held to the same
 * permission bar as Safe deployment.
 */
export async function validateSafeAdmin(
  request: Request
): Promise<AdminContext | AdminError> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const activeOrgId = getActiveOrgId(session);
  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });
  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can manage Safe policies",
      status: 403,
    };
  }

  return { organizationId: activeOrgId };
}

/**
 * Load a Safe by its id and confirm it belongs to the given organization.
 * Returns null if not found or if the Safe belongs to a different org --
 * callers should translate null into a 404 to avoid leaking existence.
 */
export async function getSafeForOrg(options: {
  safeId: string;
  organizationId: string;
}): Promise<SafeWallet | null> {
  const { safeId, organizationId } = options;
  const rows = await db
    .select()
    .from(safeWallets)
    .where(
      and(
        eq(safeWallets.id, safeId),
        eq(safeWallets.organizationId, organizationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
