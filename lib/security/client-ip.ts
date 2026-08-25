/**
 * Which request headers carry the client's IP address.
 *
 * Source of truth shared by:
 * - better-auth config (`lib/auth.ts`) - rate-limit keys and `sessions.ip_address`
 * - `resolveClientIpFromHeaders` (`lib/security/login-risk.ts`) - the session-minting
 *   routes that write `sessions.ip_address` through Drizzle instead of better-auth
 *
 * The header name was fixed at `CF-Connecting-IP` in both places. Cloudflare sets that
 * header at its own edge, so a deployment KeeperHub does not run resolves no address at
 * all: better-auth keys every rate limit on one shared bucket and the session row records
 * an empty string, while the Drizzle paths record NULL. Nothing fails loudly. This is the
 * seam that lets such a deployment name the header its own proxy sets.
 *
 * Both lists are read once at module load rather than per call, because `lib/auth.ts`
 * builds its better-auth options at import time and could not honour a later change.
 *
 * Deliberately NOT prefixed NEXT_PUBLIC_. Next inlines those into the server bundle too
 * whenever they are set at build time, which would bake the builder's value into every
 * image built from this tree.
 */

/**
 * The header consulted before this file existed. Unset yields exactly this, so KeeperHub's
 * own deployments are unaffected.
 */
const DEFAULT_CLIENT_IP_HEADERS: readonly string[] = ["cf-connecting-ip"];

/**
 * RFC 7230 token syntax, which is what a header name may contain. An entry with a space,
 * a colon or a quote is a malformed config line rather than a header anyone can send, so
 * it is dropped instead of being passed to `Headers.get`.
 */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Header names to try, in order, comma-separated, e.g.
 *   CLIENT_IP_HEADERS=X-Real-IP
 *
 * Names are lowercased for comparison only; `Headers.get` is case-insensitive either way.
 *
 * A list that parses to nothing falls back to the default rather than to an empty list.
 * An empty list would make better-auth fall back to its own `x-forwarded-for` default,
 * which is the opposite of what an operator who set the variable asked for.
 */
function parseClientIpHeaders(raw: string | undefined): readonly string[] {
  if (!raw) {
    return DEFAULT_CLIENT_IP_HEADERS;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && HEADER_NAME_PATTERN.test(entry));
  return parsed.length > 0 ? parsed : DEFAULT_CLIENT_IP_HEADERS;
}

/**
 * Proxy addresses or CIDR ranges the request passes through, comma-separated, e.g.
 *   CLIENT_IP_TRUSTED_PROXIES=10.42.0.0/16,192.168.1.5
 *
 * Only better-auth reads this. Without it better-auth refuses a header that carries more
 * than one comma-separated hop, because the leftmost hop is caller-controlled and it has no
 * way to tell which hops are its own proxies. Naming the proxies lets it walk the chain from
 * the right and take the first hop that is not one of them.
 *
 * Entries are not validated here. better-auth parses each one and logs the invalid ones,
 * so a second parser would only disagree with it.
 */
function parseTrustedProxies(raw: string | undefined): readonly string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const CLIENT_IP_HEADERS: readonly string[] = parseClientIpHeaders(
  process.env.CLIENT_IP_HEADERS
);

export const CLIENT_IP_TRUSTED_PROXIES: readonly string[] = parseTrustedProxies(
  process.env.CLIENT_IP_TRUSTED_PROXIES
);
