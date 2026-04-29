/**
 * Trusted origins for cookie-authenticated requests.
 *
 * Source of truth shared by:
 * - better-auth config (`lib/auth.ts`) — guards `/api/auth/**`
 * - root `middleware.ts` — guards all other `/api/**` POST/PATCH/PUT/DELETE
 * - `lib/middleware/auth-helpers.ts` — defence-in-depth on session-authed routes
 *
 * This module is Edge-runtime safe (no Node-only imports) so the root
 * middleware can use it directly. See KEEP-240.
 *
 * Wildcard syntax matches better-auth's behaviour: `*` matches any sequence
 * of characters except `/` and `\`. So `https://*.keeperhub.com` matches
 * `https://app.keeperhub.com` and `https://app.staging.keeperhub.com` alike.
 */

export const TRUSTED_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  // start custom keeperhub code //
  "http://127.0.0.1:*", // CLI browser auth callback (dynamic port)
  // end keeperhub code //
  "https://app-staging.keeperhub.com",
  "https://*.keeperhub.com",
];

const REGEX_META = new Set([
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
  "?",
]);

function compilePattern(pattern: string): RegExp {
  let result = "";
  for (const char of pattern) {
    if (char === "*") {
      result += "[^/\\\\]*";
    } else if (REGEX_META.has(char)) {
      result += `\\${char}`;
    } else {
      result += char;
    }
  }
  return new RegExp(`^${result}$`);
}

const COMPILED_PATTERNS: ReadonlyArray<{ pattern: string; regex: RegExp }> =
  TRUSTED_ORIGINS.map((pattern) => ({
    pattern,
    regex: compilePattern(pattern),
  }));

/**
 * Normalises an `Origin` or `Referer` header value to a bare origin
 * (`scheme://host[:port]`). Returns `null` if the value cannot be parsed.
 */
export function normaliseOrigin(
  value: string | null | undefined
): string | null {
  if (!value || value === "null") {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Returns true when the given origin matches any entry in `TRUSTED_ORIGINS`.
 * The input must be a full origin (e.g. `https://app.keeperhub.com`).
 */
export function isTrustedOrigin(origin: string): boolean {
  for (const { regex } of COMPILED_PATTERNS) {
    if (regex.test(origin)) {
      return true;
    }
  }
  return false;
}
