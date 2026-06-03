/**
 * Central registry of Redis key builders. Keep key strings here, not inlined
 * at call sites, so namespaces can't drift.
 */

// Per-deployment namespace. staging and every PR env share one Redis instance,
// so keys are prefixed to keep them isolated. Not NODE_ENV: staging and PR
// envs are both "development". Set REDIS_KEY_PREFIX per deployment.
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? "local";

/** Joins `parts` into a Redis key under the per-deployment namespace. */
export function deploymentKey(...parts: string[]): string {
  return [KEY_PREFIX, ...parts].join(":");
}

/** `ip` must be the normalized /24-or-/64 trust key (matches user_trusted_ips). */
export function newIpNotifyClaimKey(userId: string, ip: string): string {
  return deploymentKey("ip-notify", userId, ip);
}
