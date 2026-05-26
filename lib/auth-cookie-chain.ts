/**
 * Helpers for chaining Better Auth's server-side API calls
 * (auth.api.signInEmail -> auth.api.verifyTOTP) inside a single
 * request handler.
 *
 * Better Auth attaches response cookies via Set-Cookie headers on
 * the returned Headers object. To pass those cookies to the next
 * chained call (which reads them via getSignedCookie), we forward
 * them as a Cookie request header.
 *
 * Headers.get("set-cookie") returns ALL Set-Cookie values
 * comma-joined; reconstructing individual cookies from that string
 * is fragile. Cookie names with leading underscores (Better Auth's
 * production `__Secure-*` prefix) break naive regex splits keyed on
 * a leading [A-Za-z], silently dropping the two_factor cookie and
 * surfacing as Invalid two factor cookie at the next chained call.
 *
 * getSetCookie() returns each Set-Cookie as a discrete string and
 * sidesteps the parse entirely. It's available on Node 20+ /
 * undici 5.x; we feature-detect for older test runtimes.
 */

type HeadersWithGetSetCookie = Headers & {
  getSetCookie?: () => string[];
};

export function readAllSetCookies(headers: Headers): string[] {
  const h = headers as HeadersWithGetSetCookie;
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const single = headers.get?.("set-cookie");
  return single ? [single] : [];
}

export function setCookiesToCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((sc) => sc.split(";")[0].trim())
    .filter((pair) => pair.length > 0)
    .join("; ");
}
