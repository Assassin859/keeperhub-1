/**
 * Central registry of Redis key builders. Keep key strings here, not inlined
 * at call sites, so namespaces don't drift.
 */

/** `ip` must be the normalized /24-or-/64 trust key (matches user_trusted_ips). */
export function newIpNotifyClaimKey(userId: string, ip: string): string {
  return `ip-notify:${userId}:${ip}`;
}
