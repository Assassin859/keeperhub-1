/**
 * Detects anonymous/temporary users by checking name and email patterns.
 * Works with session user objects, API responses, or any object with name/email.
 */
export function isAnonymousUser(
  user: { name?: string | null; email?: string | null } | null | undefined
): boolean {
  if (!user) {
    return true;
  }
  return (
    user.name === "Anonymous" ||
    Boolean(user.email?.includes("@http://")) ||
    Boolean(user.email?.includes("@https://")) ||
    Boolean(user.email?.startsWith("temp-"))
  );
}

type SessionLike = {
  user?: {
    name?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  } | null;
} | null;

/**
 * True when the visitor should still be guided to sign in: either anonymous or
 * signed up but not yet email-verified. Mirrors the condition that renders the
 * Sign In button in components/workflows/user-menu.tsx.
 */
export function isNewUserSession(session: SessionLike | undefined): boolean {
  return (
    isAnonymousUser(session?.user) || session?.user?.emailVerified !== true
  );
}
