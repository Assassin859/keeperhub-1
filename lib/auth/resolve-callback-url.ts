/**
 * Same-origin callbackURL resolver — open-redirect guard (FUNNEL-02 / 54-02).
 *
 * Social OAuth sign-in passes a `callbackURL` to the provider. If that value
 * originates from user-controlled intent.redirectTo, an attacker could supply
 * a scheme-relative or absolute URL (e.g. "//evil.com") and redirect the
 * victim post-sign-in to an attacker-controlled page.
 *
 * This function accepts only paths that are unambiguously same-origin:
 *   - Must start with exactly one "/" (scheme-relative "//" is rejected)
 *   - Must not contain "://" (rejects "https://", "http://", etc.)
 *   - Must not contain a backslash (rejects "/\evil.com", "\evil.com")
 *
 * Any value that fails these checks — including undefined or empty string —
 * is replaced with `fallbackPath`.
 */
export function resolveCallbackUrl(
  redirectTo: string | undefined,
  fallbackPath: string
): string {
  if (!redirectTo) {
    return fallbackPath;
  }

  // Must start with exactly one "/" — "//..." is scheme-relative.
  if (!redirectTo.startsWith("/") || redirectTo.startsWith("//")) {
    return fallbackPath;
  }

  // Reject embedded scheme separator (e.g. "/scan/..//evil.com://…").
  if (redirectTo.includes("://")) {
    return fallbackPath;
  }

  // Reject backslash — browsers parse "/\evil.com" as "//evil.com" on Windows.
  if (redirectTo.includes("\\")) {
    return fallbackPath;
  }

  return redirectTo;
}
