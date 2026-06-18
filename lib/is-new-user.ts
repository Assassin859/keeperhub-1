// Shared predicates for deriving a visitor's onboarding state from a Better
// Auth session. Kept in one place so the Sign In surface (user-menu) and the
// onboarding tour cannot drift on what counts as a "new" user.

type SessionUserStatus = {
  user?: {
    name?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  } | null;
};

/**
 * True when the session has no real account behind it. Better Auth's anonymous
 * plugin creates throwaway users named "Anonymous" with a `temp-` email.
 */
export function isAnonymousUser(
  session: SessionUserStatus | null | undefined
): boolean {
  const user = session?.user;
  if (!user) {
    return true;
  }
  return (
    user.name === "Anonymous" || (user.email?.startsWith("temp-") ?? false)
  );
}

/**
 * True when the visitor should still be guided to sign in: either anonymous or
 * signed up but not yet email-verified. Mirrors the condition that renders the
 * Sign In button in `components/workflows/user-menu.tsx`.
 */
export function isNewUserSession(
  session: SessionUserStatus | null | undefined
): boolean {
  return isAnonymousUser(session) || session?.user?.emailVerified !== true;
}
