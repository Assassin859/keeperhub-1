import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";

/**
 * Discriminated by the `ok` field so callers can narrow with
 * `if (!guard.ok)` and reach `guard.error / status / code` without
 * TypeScript losing track on the success branch.
 */
export type GuardOk = { ok: true };
export type GuardError = {
  ok: false;
  error: string;
  status: 403;
  code: "not_owner" | "not_admin_or_owner" | "mfa_not_enrolled" | "mfa_pending";
};

/**
 * Gate for the most dangerous org actions: private-key export, fund
 * withdrawal. Three checks combine:
 *
 *   1. role = "owner" in the target org. Admins and members are
 *      refused — these actions can move funds or exfiltrate keys, so
 *      the role floor is owner.
 *   2. users.two_factor_enabled = true. Owners must carry a second
 *      factor for these actions; if not enrolled, the action is
 *      refused with code "mfa_not_enrolled" so the client can route
 *      them to settings.
 *   3. sessions.requires_mfa = false. If the session was flagged at
 *      login by login-risk detection, the client must complete the
 *      /verify-mfa step-up before this action will be honored.
 *
 * Better Auth's getSession does not type `requires_mfa` in its
 * inferred session shape (custom field outside the plugin schema), so
 * callers extract it themselves and pass the boolean in.
 */
export async function requireOwnerWithMfa(
  userId: string,
  organizationId: string,
  requiresMfa: boolean
): Promise<GuardOk | GuardError> {
  if (requiresMfa) {
    return {
      ok: false,
      error: "Complete step-up verification before this action",
      status: 403,
      code: "mfa_pending",
    };
  }

  const [row] = await db
    .select({
      role: member.role,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);

  if (!row || row.role !== "owner") {
    return {
      ok: false,
      error: "Only organization owners can perform this action",
      status: 403,
      code: "not_owner",
    };
  }

  if (row.twoFactorEnabled !== true) {
    return {
      ok: false,
      error:
        "Enable two-factor authentication on your account before this action",
      status: 403,
      code: "mfa_not_enrolled",
    };
  }

  return { ok: true };
}

/**
 * Relaxed variant: accepts admin or owner. Used for actions that are
 * sensitive but not destructive enough to demand owner-only —
 * typically inverse operations like revoking an API key vs. minting
 * one, or removing a member vs. promoting one.
 */
export async function requireAdminOrOwnerWithMfa(
  userId: string,
  organizationId: string,
  requiresMfa: boolean
): Promise<GuardOk | GuardError> {
  if (requiresMfa) {
    return {
      ok: false,
      error: "Complete step-up verification before this action",
      status: 403,
      code: "mfa_pending",
    };
  }

  const [row] = await db
    .select({
      role: member.role,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);

  if (!row || (row.role !== "admin" && row.role !== "owner")) {
    return {
      ok: false,
      error: "Only organization admins and owners can perform this action",
      status: 403,
      code: "not_admin_or_owner",
    };
  }

  if (row.twoFactorEnabled !== true) {
    return {
      ok: false,
      error:
        "Enable two-factor authentication on your account before this action",
      status: 403,
      code: "mfa_not_enrolled",
    };
  }

  return { ok: true };
}

/**
 * Self-scoped MFA gate for flows where org role is not the relevant
 * axis (agentic-wallet approve/reject is already gated on the
 * wallet-linker; user-scoped API keys live on the user, not the org).
 */
export async function requireMfaEnrolled(
  userId: string,
  requiresMfa: boolean
): Promise<GuardOk | GuardError> {
  if (requiresMfa) {
    return {
      ok: false,
      error: "Complete step-up verification before this action",
      status: 403,
      code: "mfa_pending",
    };
  }
  const [row] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row?.twoFactorEnabled !== true) {
    return {
      ok: false,
      error:
        "Enable two-factor authentication on your account before this action",
      status: 403,
      code: "mfa_not_enrolled",
    };
  }
  return { ok: true };
}
