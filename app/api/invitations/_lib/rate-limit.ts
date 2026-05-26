// In-memory per pod. In a multi-replica deployment, each pod tracks its own
// window. Effective limit is LIMIT * num_replicas. Replace with Redis-backed
// solution when replica count grows.
//
// This endpoint is unauthenticated (the invite ID is a high-entropy bearer
// token), so the only available rate-limit key is the client IP. The limit is
// generous because a legitimate caller opening the manage-orgs modal fetches
// one entry per pending invitation in parallel.

const WINDOW_MS = 60_000;
const LIMIT = 60;

const requestLog = new Map<string, number[]>();

export type InviteRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

export function checkInviteFetchRateLimit(key: string): InviteRateLimitResult {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = requestLog.get(key);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= LIMIT) {
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  recent.push(now);
  requestLog.set(key, recent);

  return { allowed: true };
}

// Derives the rate-limit bucket from the forwarded client IP. Falls back to a
// shared "unknown" bucket when no IP header is present so the limiter still
// applies (conservatively) rather than failing open per-request.
export function getInviteFetchRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
  return ip ? `ip:${ip}` : "ip:unknown";
}

// Test-only reset hook. Production code never imports this.
export function __resetInviteFetchRateLimitForTests(): void {
  requestLog.clear();
}
