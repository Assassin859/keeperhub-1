import { type NextRequest, NextResponse } from "next/server";
import {
  hasSessionCookie,
  isTrustedOrigin,
  normaliseOrigin,
} from "@/lib/trusted-origins";

/**
 * CSRF defence: enforce Origin header against trustedOrigins on state-changing
 * /api/** requests that carry a better-auth session cookie. Layered with
 * SameSite=Lax cookies (better-auth default) to close sibling-subdomain CSRF
 * gaps. See KEEP-240.
 *
 * The cookie check is scoped to the better-auth session token rather than any
 * cookie, so Bearer/API-key callers that happen to traverse Cloudflare Access
 * (which sets `CF_AppSession` / `CF_Authorization`) aren't false-positively
 * blocked.
 *
 * Exempts paths that legitimately accept cross-origin POSTs and don't depend
 * on session cookies (webhooks, cron, OAuth client flow, MCP workflow calls,
 * better-auth's own router which has its own origin check).
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const EXEMPT_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/billing/webhooks/",
  "/api/cron/",
  "/api/oauth/",
];

const EXEMPT_PATTERNS: readonly RegExp[] = [
  /^\/api\/workflows\/[^/]+\/webhook(?:\/|$)/,
  /^\/api\/mcp\/workflows\/[^/]+\/call(?:\/|$)/,
];

function isExemptPath(pathname: string): boolean {
  for (const prefix of EXEMPT_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  for (const regex of EXEMPT_PATTERNS) {
    if (regex.test(pathname)) {
      return true;
    }
  }
  return false;
}

export function proxy(request: NextRequest): NextResponse {
  const { method, nextUrl, headers } = request;

  if (!STATE_CHANGING_METHODS.has(method)) {
    return NextResponse.next();
  }

  if (isExemptPath(nextUrl.pathname)) {
    return NextResponse.next();
  }

  // Only enforce when the request actually carries the better-auth session
  // cookie. Cookieless callers and callers with only unrelated cookies
  // (Cloudflare Access tokens, analytics) bypass the check.
  if (!hasSessionCookie(headers)) {
    return NextResponse.next();
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

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
