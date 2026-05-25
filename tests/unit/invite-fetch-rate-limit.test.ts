import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInviteFetchRateLimitForTests,
  checkInviteFetchRateLimit,
  getInviteFetchRateLimitKey,
} from "@/app/api/invitations/_lib/rate-limit";

describe("getInviteFetchRateLimitKey", () => {
  it("uses the first IP from x-forwarded-for", () => {
    const request = new Request("https://example.com/api/invitations/abc", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(getInviteFetchRateLimitKey(request)).toBe("ip:203.0.113.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("https://example.com/api/invitations/abc", {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    expect(getInviteFetchRateLimitKey(request)).toBe("ip:203.0.113.9");
  });

  it("returns the shared unknown bucket when no IP header is present", () => {
    const request = new Request("https://example.com/api/invitations/abc");
    expect(getInviteFetchRateLimitKey(request)).toBe("ip:unknown");
  });
});

describe("checkInviteFetchRateLimit", () => {
  beforeEach(() => {
    __resetInviteFetchRateLimitForTests();
  });

  it("allows requests up to the per-window limit", () => {
    for (let i = 0; i < 60; i += 1) {
      expect(checkInviteFetchRateLimit("ip:test").allowed).toBe(true);
    }
  });

  it("rejects the request that exceeds the window limit", () => {
    for (let i = 0; i < 60; i += 1) {
      checkInviteFetchRateLimit("ip:test");
    }
    const result = checkInviteFetchRateLimit("ip:test");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThanOrEqual(1);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it("isolates buckets by IP", () => {
    for (let i = 0; i < 60; i += 1) {
      checkInviteFetchRateLimit("ip:a");
    }
    expect(checkInviteFetchRateLimit("ip:a").allowed).toBe(false);
    expect(checkInviteFetchRateLimit("ip:b").allowed).toBe(true);
  });
});
