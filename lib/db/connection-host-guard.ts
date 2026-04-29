/**
 * SSRF guards for the database connection-test endpoint.
 *
 * Lives in its own module (rather than connection-utils.ts) because it
 * pulls in `lib/safe-fetch.ts`, which has `import "server-only"`.
 * `drizzle.config.ts` imports `getDatabaseUrl` from connection-utils at
 * CLI time (drizzle-kit, migrations, CI setup-db), and any transitive
 * `server-only` import there blows up the config load with "This module
 * cannot be imported from a Client Component module."
 *
 * Keeping the guard isolated lets `connection-utils.ts` stay
 * import-clean for tooling that runs outside Next's server runtime.
 */
import "server-only";

import type { LookupAddress } from "node:dns";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { isBlockedIp } from "@/lib/safe-fetch";

/**
 * Reject connection-test attempts against private / loopback / link-local
 * destinations. Used by the integration-test endpoint, which dials a
 * user-supplied host over raw TCP via the `postgres` package, a path that
 * does not go through `safe-fetch.ts` (HTTP-only). Always-on (no env
 * flag): there is no legitimate reason for an `/api/integrations/test`
 * request to resolve to a non-public address.
 *
 * Caveat: there is a small TOCTOU window between this DNS check and the
 * subsequent TCP connect during which an attacker-controlled domain
 * could rebind. Closing that window requires resolving once and
 * dialling the resolved IP directly, which is out of scope for this
 * fix (would mean rewriting how the postgres client is invoked). The
 * TOCTOU surface for postgres TCP is much narrower than HTTP DNS
 * rebinding (no scriptable client behind the connection), so we accept
 * it here.
 */
export async function assertHostIsPublic(host: string): Promise<void> {
  const trimmed = host.trim();
  if (trimmed === "") {
    throw new Error("Host is required");
  }

  if (isIP(trimmed) !== 0) {
    const verdict = isBlockedIp(trimmed);
    if (verdict.blocked) {
      throw new Error("Host is not allowed: must resolve to a public address");
    }
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(trimmed, { all: true });
  } catch {
    throw new Error("Host could not be resolved");
  }

  for (const addr of addresses) {
    const verdict = isBlockedIp(addr.address);
    if (verdict.blocked) {
      throw new Error("Host is not allowed: must resolve to a public address");
    }
  }
}

/**
 * Extract the hostname from a postgres connection URL.
 *
 * Returns null if the URL is malformed; callers should treat that as a
 * validation failure.
 */
export function extractHostFromConnectionString(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
