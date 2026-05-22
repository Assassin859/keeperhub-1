import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";

export type OwnerMfaError = {
  error: string;
  status: 403;
  code: "not_owner" | "mfa_not_enrolled" | "mfa_pending";
};

export type OwnerMfaOk = {
  ok: true;
};

/**
 * Gate for the most dangerous org actions: private-key export, fund
 * withdrawal, org deletion. Three checks combine into one pass:
 *
 *   1. The caller must be a member of the org with `role = "owner"`.
 *      Admins and members are refused — these actions can move funds
 *      or destroy the org outright; the role is the floor, not the
 *      ceiling.
 *   2. The caller must have TOTP enrolled (`users.two_factor_enabled
 *      = true`). Owners are required to carry a second factor for
 *      these actions; if they haven't enrolled, the action is refused
 *      with a `mfa_not_enrolled` code the client can use to send them
 *      to settings.
 *   3. The session being used must have passed step-up
 *      (`sessions.requires_mfa = false`). If the session was flagged
 *      at login by login-risk detection, the client must complete
 *      /verify-mfa before this action will be honored.
 *
 * The session.session object returned by Better Auth's getSession
 * doesn't include our custom requires_mfa field in its TypeScript
 * type, so the caller extracts it themselves (it lives on
 * sessions.requires_mfa in the DB but better-auth doesn't widen its
 * inferred types). Pass `false` if the field isn't readable.
 *
 * Returned error objects carry a `code` so callers can surface
 * different UX for "enroll MFA first" vs "complete step-up now"
 * without parsing strings.
 */
export async function requireOwnerWithMfa(
  userId: string,
  organizationId: string,
  requiresMfa: boolean
): Promise<OwnerMfaOk | OwnerMfaError> {
  if (requiresMfa) {
    return {
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
      error: "Only organization owners can perform this action",
      status: 403,
      code: "not_owner",
    };
  }

  if (row.twoFactorEnabled !== true) {
    return {
      error:
        "Enable two-factor authentication on your account before this action",
      status: 403,
      code: "mfa_not_enrolled",
    };
  }

  return { ok: true };
}
