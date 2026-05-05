// In-memory per pod. In a multi-replica deployment, each pod tracks its own window.
// Effective limit is LIMIT * num_replicas. Replace with Redis-backed solution
// when replica count grows.

const WINDOW_MS = 60_000; // 1 minute
const LIMIT = 120; // requests per window (higher than execute endpoint; MCP sessions are chatty)

// Stale-entry sweep: anything whose newest timestamp is older than
// (STALE_THRESHOLD_MULTIPLIER * maxWindowMs) can never affect a rate-limit
// decision and exists only as map-key overhead. The largest window is
// tracked dynamically so future callers with longer windows are safe by
// construction -- no caller can introduce a window that races the sweep.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MULTIPLIER = 5;

const requestLog = new Map<string, number[]>();
const ipRequestLog = new Map<string, number[]>();

let maxWindowMs = WINDOW_MS;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

export function checkMcpRateLimit(organizationId: string): RateLimitResult {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = requestLog.get(organizationId);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= LIMIT) {
    // Oldest timestamp in window determines when the first slot opens
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  recent.push(now);
  requestLog.set(organizationId, recent);

  return { allowed: true };
}

export function checkIpRateLimit(
  ip: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  if (windowMs > maxWindowMs) {
    maxWindowMs = windowMs;
  }
  const now = Date.now();
  const windowStart = now - windowMs;

  const timestamps = ipRequestLog.get(ip);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= limit) {
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  recent.push(now);
  ipRequestLog.set(ip, recent);

  return { allowed: true };
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

// Walk both maps and drop entries whose newest timestamp is older than the
// stale threshold. Inline cleanup on the request path can't fix this leak
// because it only fires when the same key comes back; entries leak when an
// org/IP makes requests once and never returns.
export function cleanupStaleRateLimitEntries(): void {
  const cutoff = Date.now() - maxWindowMs * STALE_THRESHOLD_MULTIPLIER;
  for (const [key, timestamps] of requestLog) {
    const newest = timestamps.at(-1);
    if (newest === undefined || newest <= cutoff) {
      requestLog.delete(key);
    }
  }
  for (const [key, timestamps] of ipRequestLog) {
    const newest = timestamps.at(-1);
    if (newest === undefined || newest <= cutoff) {
      ipRequestLog.delete(key);
    }
  }
}

export function startRateLimitCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
  }
  cleanupTimer = setInterval(
    cleanupStaleRateLimitEntries,
    CLEANUP_INTERVAL_MS
  );
  if (
    cleanupTimer !== null &&
    typeof cleanupTimer === "object" &&
    "unref" in cleanupTimer
  ) {
    cleanupTimer.unref();
  }
}

export function stopRateLimitCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Tracked-entry counts. Useful for /healthz or memory observability.
export function getRateLimitStats(): {
  organizationCount: number;
  ipCount: number;
} {
  return {
    organizationCount: requestLog.size,
    ipCount: ipRequestLog.size,
  };
}

// Test-only: clears all in-process state (maps + tracked window). Tests need
// this because `maxWindowMs` is module-scoped and can otherwise leak between
// cases that exercise different window sizes.
export function resetRateLimitState(): void {
  requestLog.clear();
  ipRequestLog.clear();
  maxWindowMs = WINDOW_MS;
}
