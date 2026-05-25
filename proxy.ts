import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  hasSessionCookie,
  isTrustedOrigin,
  normaliseOrigin,
} from "@/lib/trusted-origins";

/**
 * Root request proxy. Two gates run in order on every matched request:
 *
 *  1. CSRF defence: enforce Origin against trustedOrigins on state-
 *     changing /api/** requests that carry a better-auth session cookie.
 *     Layered with SameSite=Lax cookies to close sibling-subdomain CSRF.
 *     The cookie check is scoped to the better-auth session token, so
 *     Bearer/API-key callers behind Cloudflare Access (which sets
 *     `CF_AppSession` / `CF_Authorization`) are not false-positively
 *     blocked. See KEEP-240.
 *
 *  2. Mandatory-MFA gate: when an authenticated session is present,
 *     refuse to let the user reach anything except sign-out, auth
 *     callbacks, the enrollment endpoints, /enroll-mfa, and /verify-mfa
 *     until both:
 *       a. user.two_factor_enabled = true, and
 *       b. session.requires_mfa = false.
 *     Failing (a) yields 403 mfa_enrollment_required on API responses
 *     and 302 → /enroll-mfa on page navigation. Failing (b) yields 403
 *     mfa_pending and 302 → /verify-mfa. Unauthenticated requests pass
 *     through untouched — route handlers remain responsible for their
 *     own auth/authorization, and API-key-based requests carry no
 *     session cookie so they bypass the MFA gate by construction.
 */

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const CSRF_EXEMPT_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/billing/webhooks/",
  "/api/cron/",
  "/api/oauth/",
];

const CSRF_EXEMPT_PATTERNS: readonly RegExp[] = [
  /^\/api\/workflows\/[^/]+\/webhook(?:\/|$)/,
  /^\/api\/mcp\/workflows\/[^/]+\/call(?:\/|$)/,
];

function isCsrfExemptPath(pathname: string): boolean {
  for (const prefix of CSRF_EXEMPT_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  for (const regex of CSRF_EXEMPT_PATTERNS) {
    if (regex.test(pathname)) {
      return true;
    }
  }
  return false;
}

function csrfBlock(request: NextRequest): NextResponse | null {
  const { method, nextUrl, headers } = request;

  if (!nextUrl.pathname.startsWith("/api/")) {
    return null;
  }
  if (!STATE_CHANGING_METHODS.has(method)) {
    return null;
  }
  if (isCsrfExemptPath(nextUrl.pathname)) {
    return null;
  }
  if (!hasSessionCookie(headers)) {
    return null;
  }

  const rawOrigin = headers.get("origin") ?? headers.get("referer");
  const origin = normaliseOrigin(rawOrigin);

  if (!origin) {
    console.info("[csrf] blocked: missing origin", {
      method,
      path: nextUrl.pathname,
    });
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  if (!isTrustedOrigin(origin)) {
    console.info("[csrf] blocked: untrusted origin", {
      method,
      path: nextUrl.pathname,
      origin,
    });
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  return null;
}

// ---------------------------------------------------------------------------
// MFA gate
// ---------------------------------------------------------------------------

/**
 * API path prefixes that a locked session must still reach. Better Auth's
 * catch-all covers sign-in / sign-out / two-factor verify / OAuth callbacks;
 * the totp/* endpoints are needed for the enrollment + step-up flows; the
 * forgot-password endpoint is anonymous; the OG endpoint is public; health,
 * cron, and MCP schemas have no session-bearer browser caller.
 */
const MFA_EXEMPT_API_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/user/totp/",
  "/api/user/verify-ip",
  "/api/user/forgot-password",
  "/api/og/",
  "/api/health",
  "/api/mcp/schemas",
  "/api/cron/",
];

/**
 * Marketing / standalone page routes plus the gate pages themselves.
 * `/` is intentionally NOT in this set: signed-out visitors land
 * there and `hasSessionCookie` short-circuits the gate for them, but
 * signed-in users on `/` must still be routed through enrollment /
 * step-up before any other navigation.
 */
const MFA_EXEMPT_PAGES = new Set<string>([
  "/pricing",
  "/about",
  "/terms",
  "/privacy",
  "/enroll-mfa",
  "/verify-mfa",
  "/verify-ip",
]);

const MFA_EXEMPT_PAGE_PREFIXES: readonly string[] = [
  "/docs",
  "/sign-in",
  "/sign-up",
];

function isMfaExemptPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) {
    for (const prefix of MFA_EXEMPT_API_PREFIXES) {
      if (pathname.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
  if (MFA_EXEMPT_PAGES.has(pathname)) {
    return true;
  }
  for (const prefix of MFA_EXEMPT_PAGE_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function mfaApiError(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

function mfaRedirect(
  request: NextRequest,
  target: string,
  reason: string
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = target;
  url.search = "";
  url.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search
  );
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

async function mfaBlock(request: NextRequest): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl;

  if (isMfaExemptPath(pathname)) {
    return null;
  }
  // No session cookie at all → no session → nothing to gate on. Route
  // handlers + public pages serve themselves; API-key callers skip the
  // gate naturally because they don't carry the session cookie.
  if (!hasSessionCookie(request.headers)) {
    return null;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return null;
  }

  const apiPath = pathname.startsWith("/api/");
  const user = session.user as { twoFactorEnabled?: boolean | null };
  const sess = session.session as { requiresMfa?: boolean | null };

  if (user.twoFactorEnabled !== true) {
    if (apiPath) {
      return mfaApiError(
        403,
        "mfa_enrollment_required",
        "Enable two-factor authentication on your account before continuing."
      );
    }
    return mfaRedirect(request, "/enroll-mfa", "enroll");
  }

  if (sess.requiresMfa === true) {
    if (apiPath) {
      return mfaApiError(
        403,
        "mfa_pending",
        "Verify your second factor to continue."
      );
    }
    return mfaRedirect(request, "/verify-mfa", "verify");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Composed proxy entry point
// ---------------------------------------------------------------------------

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const csrfResponse = csrfBlock(request);
  if (csrfResponse) {
    return csrfResponse;
  }
  const mfaResponse = await mfaBlock(request);
  if (mfaResponse) {
    return mfaResponse;
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *   - _next/static, _next/image  (build artefacts)
     *   - favicon.ico, robots.txt, sitemap.xml (root static files)
     *   - public/*  (anything mounted from public/)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|public/).*)",
  ],
};
