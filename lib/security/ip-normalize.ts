/**
 * Canonical "trust key" for an IP. Two addresses normalize to the
 * same string when they represent the same network for IP-trust
 * purposes; the comparison in `assessIpTrust` and the storage in
 * `user_trusted_ips` both go through this so a textual mismatch
 * never causes a false-negative.
 *
 *   - IPv4 (32 bits): returned unchanged. /32 is what the address
 *     itself already represents.
 *   - IPv6 (128 bits): collapsed to the /64 prefix with zero-padded
 *     groups. Cloudflare zeros out the lower 64 bits of an IPv6
 *     CF-Connecting-IP for privacy, so the same end user produces
 *     a different textual address every time a new SLAAC interface
 *     identifier is generated — but the /64 prefix is the network
 *     they belong to, and that's what we should be tracking trust
 *     against.
 *
 * Malformed input is returned unchanged. assessIpTrust treats it
 * as a fresh address, which falls back through the same flow as
 * any unknown IP.
 */

const TRAILING_ZERO_GROUPS_RE = /(?::0+){2,}$/;

function padGroup(group: string): string {
  return group.padStart(4, "0");
}

/**
 * Display form of a normalized IP. IPv4 is returned unchanged.
 * Normalized IPv6 (always stored with the last four groups set to
 * `:0000:0000:0000:0000` after `normalizeIpForTrust`) renders as
 * just the /64 prefix without the trailing zero groups, so
 * `2803:a920:289b:d6c0:0000:0000:0000:0000` -> `2803:a920:289b:d6c0`.
 * The dropped groups are always zeros for normalized rows, so no
 * information is lost; the result reads cleaner in the
 * active-sessions panel than the IPv6 shorthand `::` suffix would.
 */
export function formatIpForDisplay(ip: string): string {
  if (!ip.includes(":")) {
    return ip;
  }
  return ip.replace(TRAILING_ZERO_GROUPS_RE, "");
}

export function normalizeIpForTrust(ip: string): string {
  if (!ip.includes(":")) {
    return ip;
  }
  let expanded = ip.toLowerCase();
  if (expanded.includes("::")) {
    const [leftRaw = "", rightRaw = ""] = expanded.split("::");
    const leftGroups = leftRaw ? leftRaw.split(":") : [];
    const rightGroups = rightRaw ? rightRaw.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) {
      return ip;
    }
    const middle = new Array(missing).fill("0");
    expanded = [...leftGroups, ...middle, ...rightGroups].join(":");
  }
  const groups = expanded.split(":");
  if (groups.length !== 8) {
    return ip;
  }
  return [
    padGroup(groups[0]),
    padGroup(groups[1]),
    padGroup(groups[2]),
    padGroup(groups[3]),
    "0000",
    "0000",
    "0000",
    "0000",
  ].join(":");
}
