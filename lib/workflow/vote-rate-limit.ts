// In-memory per-user vote rate limiter.
// Same sliding window approach as lib/mcp/rate-limit.ts.

const WINDOW_MS = 60_000; // 1 minute
const LIMIT = 20; // votes per window per user

const voteLog = new Map<string, number[]>();

export function checkVoteRateLimit(userId: string): boolean {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = voteLog.get(userId);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= LIMIT) {
    return false;
  }

  recent.push(now);
  voteLog.set(userId, recent);

  return true;
}
