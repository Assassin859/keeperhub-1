import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkIpRateLimit,
  checkMcpRateLimit,
  cleanupStaleRateLimitEntries,
  getRateLimitStats,
  stopRateLimitCleanupInterval,
} from "@/lib/mcp/rate-limit";

const MINUTE_MS = 60_000;
const STALE_AFTER_MS = 5 * MINUTE_MS;
const ONE_DAY_MS = 24 * 60 * MINUTE_MS;
const MCP_LIMIT = 120;

describe("mcp/rate-limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    stopRateLimitCleanupInterval();
    // Module-scoped maps persist between tests; advance well past the stale
    // window and run cleanup so the next test starts from an empty slate.
    vi.setSystemTime(Date.now() + ONE_DAY_MS);
    cleanupStaleRateLimitEntries();
    vi.useRealTimers();
  });

  describe("cleanupStaleRateLimitEntries", () => {
    it("removes organisation entries whose newest timestamp is past the stale threshold", () => {
      checkMcpRateLimit("org-a");
      expect(getRateLimitStats().organizationCount).toBe(1);

      vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1);
      cleanupStaleRateLimitEntries();

      expect(getRateLimitStats().organizationCount).toBe(0);
    });

    it("removes IP entries whose newest timestamp is past the stale threshold", () => {
      checkIpRateLimit("1.2.3.4", 10, MINUTE_MS);
      expect(getRateLimitStats().ipCount).toBe(1);

      vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1);
      cleanupStaleRateLimitEntries();

      expect(getRateLimitStats().ipCount).toBe(0);
    });

    it("preserves entries with activity inside the stale threshold", () => {
      checkMcpRateLimit("org-active");
      checkIpRateLimit("9.9.9.9", 10, MINUTE_MS);

      // Half-way through the stale window
      vi.setSystemTime(Date.now() + STALE_AFTER_MS / 2);
      cleanupStaleRateLimitEntries();

      const stats = getRateLimitStats();
      expect(stats.organizationCount).toBe(1);
      expect(stats.ipCount).toBe(1);
    });

    it("does not break rate-limit decisions when called against an at-limit entry", () => {
      const allowed = Array.from({ length: MCP_LIMIT }, () =>
        checkMcpRateLimit("org-busy")
      );
      expect(allowed.every((r) => r.allowed)).toBe(true);

      const blocked = checkMcpRateLimit("org-busy");
      expect(blocked.allowed).toBe(false);

      // Cleanup must NOT drop an entry whose newest timestamp is `now`.
      cleanupStaleRateLimitEntries();
      expect(getRateLimitStats().organizationCount).toBe(1);

      // And the block must persist.
      const stillBlocked = checkMcpRateLimit("org-busy");
      expect(stillBlocked.allowed).toBe(false);
    });

    it("reproduces the leak case: idle keys accumulate without cleanup, are released after cleanup (KEEP-419)", () => {
      checkMcpRateLimit("org-a");
      vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1);

      // Without cleanup: a brand-new key is added and the stale one stays.
      checkMcpRateLimit("org-b");
      expect(getRateLimitStats().organizationCount).toBe(2);

      // With cleanup: only the recently-active key remains.
      cleanupStaleRateLimitEntries();
      expect(getRateLimitStats().organizationCount).toBe(1);
    });
  });
});
