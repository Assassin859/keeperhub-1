import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sendNewIpAttemptEmail } from "@/lib/email";
import { describeUserAgentLabel } from "@/lib/security/device-label";
import { gateRequestIp } from "@/lib/security/login-risk";
import {
  buildPendingIpSetCookie,
  encodePendingIpCookie,
} from "@/lib/pending-ip-cookie";
import {
  hasSessionCookie,
  isTrustedOrigin,
  normaliseOrigin,
} from "@/lib/trusted-origins";

/**
 * Root request proxy. Three gates run in order on every matched request:
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
 *     mfa_pending and 302 → /verify-mfa.
 *
 *  3. IP trust gate: refuse to serve an authenticated request whose
 *     source IP is not in the user's `user_trusted_ips` list. Page
 *     navigations get 302 → /verify-ip with a signed pending_ip_verify
 *     cookie; API calls get 403 ip_verification_required. The trust list
 *     only grows via explicit sign-in events (first-attestation in
 *     session.create.before, or /verify-ip OTP confirmation), so an
 *     attacker who steals a session cookie cannot reuse it from a
 *     different network without going through the email-OTP step. The
 *     legitimate user gets a notification email naming the new IP,
 *     country, and device the first time we see that (user, ip) pair.
 *
 * Unauthenticated requests pass through untouched - route handlers
 * remain responsible for their own auth/authorization, and API-key
 * callers carry no session cookie so they bypass the gates by
 * construction.
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

type GatedUser = { id: string; email: string };

type MfaResult =
  | { kind: "block"; response: NextResponse }
  | { kind: "pass"; user: GatedUser | null };

async function mfaBlock(request: NextRequest): Promise<MfaResult> {
  const { pathname } = request.nextUrl;

  if (isMfaExemptPath(pathname)) {
    return { kind: "pass", user: null };
  }
  // No session cookie at all → no session → nothing to gate on. Route
  // handlers + public pages serve themselves; API-key callers skip the
  // gate naturally because they don't carry the session cookie.
  if (!hasSessionCookie(request.headers)) {
    return { kind: "pass", user: null };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { kind: "pass", user: null };
  }

  // Anonymous sessions have no permanent identity to protect, so gating
  // them on MFA is incoherent. Let them through so landing-page visitors
  // can build a workflow before signing up. Key off the authoritative
  // is_anonymous column only - the name/email heuristics in
  // auth-anonymous-guard are user-controllable (name is editable via
  // /api/user), and using them here would let a real user bypass the gate
  // by renaming themselves "Anonymous".
  if ((session.user as { isAnonymous?: boolean | null }).isAnonymous === true) {
    return { kind: "pass", user: null };
  }

  const apiPath = pathname.startsWith("/api/");
  const user = session.user as {
    twoFactorEnabled?: boolean | null;
    email?: string | null;
  };
  const sess = session.session as { requiresMfa?: boolean | null };

  if (user.twoFactorEnabled !== true) {
    if (apiPath) {
      return {
        kind: "block",
        response: mfaApiError(
          403,
          "mfa_enrollment_required",
          "Enable two-factor authentication on your account before continuing."
        ),
      };
    }
    return {
      kind: "block",
      response: mfaRedirect(request, "/enroll-mfa", "enroll"),
    };
  }

  if (sess.requiresMfa === true) {
    if (apiPath) {
      return {
        kind: "block",
        response: mfaApiError(
          403,
          "mfa_pending",
          "Verify your second factor to continue."
        ),
      };
    }
    return {
      kind: "block",
      response: mfaRedirect(request, "/verify-mfa", "verify"),
    };
  }

  if (!user.email) {
    return { kind: "pass", user: null };
  }

  return { kind: "pass", user: { id: session.user.id, email: user.email } };
}

// ---------------------------------------------------------------------------
// IP gate
// ---------------------------------------------------------------------------

/**
 * Per-pod dedup of (userId, ip) pairs we've already alerted on. Prevents
 * a single new network from generating one email per page navigation
 * while the user is mid-verification. Same shape and eviction approach
 * as the trust caches in lib/security/login-risk.ts.
 */
const NEW_IP_NOTIFIED: Set<string> = new Set();
const NEW_IP_NOTIFIED_LIMIT = 10_000;

function rememberNotified(key: string): void {
  if (NEW_IP_NOTIFIED.size >= NEW_IP_NOTIFIED_LIMIT) {
    const retained = Array.from(NEW_IP_NOTIFIED).slice(
      -Math.floor(NEW_IP_NOTIFIED_LIMIT / 2)
    );
    NEW_IP_NOTIFIED.clear();
    for (const k of retained) {
      NEW_IP_NOTIFIED.add(k);
    }
  }
  NEW_IP_NOTIFIED.add(key);
}

async function ipGateBlock(
  request: NextRequest,
  user: GatedUser
): Promise<NextResponse | null> {
  // The exempt set already lets /verify-ip, /api/user/verify-ip,
  // /api/auth/*, and the marketing pages through. Reusing it here keeps
  // the two gates from contradicting each other.
  if (isMfaExemptPath(request.nextUrl.pathname)) {
    return null;
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    // No secret means we can't sign the pending cookie, and a fail-closed
    // 500 here would lock the whole app out. Fail open: the gate is a
    // defence-in-depth layer on top of MFA, and the operator alerting on
    // the missing secret is the right corrective signal.
    return null;
  }

  const gate = await gateRequestIp(user.id);
  if (gate.kind === "trusted" || gate.kind === "no_ip") {
    return null;
  }

  const notifyKey = `${user.id}:${gate.ip}`;
  if (!NEW_IP_NOTIFIED.has(notifyKey)) {
    rememberNotified(notifyKey);
    const userAgent = request.headers.get("user-agent");
    // Fire-and-forget. SendGrid failures are already logged inside
    // sendNewIpAttemptEmail and must not block the gate response.
    sendNewIpAttemptEmail({
      email: user.email,
      ip: gate.ip,
      country: gate.country,
      device: describeUserAgentLabel(userAgent),
      when: new Date(),
    }).catch(() => {
      // Already logged inside the email helper; swallow at the boundary.
    });
  }

  const apiPath = request.nextUrl.pathname.startsWith("/api/");
  if (apiPath) {
    return NextResponse.json(
      {
        error: "Verify this network in your browser to continue.",
        code: "ip_verification_required",
      },
      { status: 403 }
    );
  }

  const cookieValue = encodePendingIpCookie(
    {
      userId: user.id,
      email: user.email,
      ip: gate.ip,
      country: gate.country,
      redirect: request.nextUrl.pathname + request.nextUrl.search,
    },
    secret
  );
  const target = request.nextUrl.clone();
  target.pathname = "/verify-ip";
  target.search = "";
  target.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search
  );
  const response = NextResponse.redirect(target);
  response.headers.append("Set-Cookie", buildPendingIpSetCookie(cookieValue));
  return response;
}

// ---------------------------------------------------------------------------
// Composed proxy entry point
// ---------------------------------------------------------------------------

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const csrfResponse = csrfBlock(request);
  if (csrfResponse) {
    return csrfResponse;
  }
  const mfaResult = await mfaBlock(request);
  if (mfaResult.kind === "block") {
    return mfaResult.response;
  }
  if (mfaResult.user) {
    const ipResponse = await ipGateBlock(request, mfaResult.user);
    if (ipResponse) {
      return ipResponse;
    }
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
