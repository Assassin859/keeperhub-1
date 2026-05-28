/**
 * Anonymous-user gate for sensitive account operations.
 *
 * The anonymous Better Auth plugin issues throwaway accounts (name =
 * "Anonymous", email starts with "temp-") that are intentionally
 * disposable. Letting them enroll TOTP, configure recovery codes, or
 * gate sessions on MFA is incoherent — there's no permanent identity to
 * protect, and any "second factor" they'd configure is lost the moment
 * the anonymous session expires.
 *
 * Use isAnonymousUserShape on the user object returned by
 * auth.api.getSession to decide whether to refuse a request or hide a
 * setting from the UI.
 */
export function isAnonymousUserShape(user: {
  email?: string | null;
  name?: string | null;
  isAnonymous?: boolean | null;
}): boolean {
  if (user.isAnonymous === true) {
    return true;
  }
  if (user.name === "Anonymous") {
    return true;
  }
  if (typeof user.email === "string" && user.email.startsWith("temp-")) {
    return true;
  }
  return false;
}
