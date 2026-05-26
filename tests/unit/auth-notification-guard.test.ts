import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFreshSignup } from "@/lib/auth-notification-guard";

// Pin "now" so windows are deterministic.
const NOW = new Date("2026-05-25T14:12:00Z");

describe("isFreshSignup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for a user created seconds ago (genuine signup)", () => {
    const createdAt = new Date(NOW.getTime() - 30 * 1000);
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns true for a user created 59 minutes ago (slow OTP verify)", () => {
    const createdAt = new Date(NOW.getTime() - 59 * 60 * 1000);
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns false for a user created more than 1 hour ago", () => {
    const createdAt = new Date(NOW.getTime() - 61 * 60 * 1000);
    expect(isFreshSignup({ createdAt })).toBe(false);
  });

  it("returns false for the four-week-old sign-up-with-existing-email regression", () => {
    // 2026-05-25 14:12 UTC: a POST /sign-up/email landed for an email that
    // already had an OAuth-only account from 2026-04-27. Better Auth sent an
    // OTP, the actor entered it, afterEmailVerification fired for the
    // already-existing user, and notifyDiscordSignup posted a false-positive
    // "New signup" alert. The guard suppresses the notification because the
    // user is not freshly created.
    const createdAt = new Date("2026-04-27T21:02:58.926Z");
    expect(isFreshSignup({ createdAt })).toBe(false);
  });

  it("treats the exact window boundary as expired (suppressed)", () => {
    const createdAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    expect(isFreshSignup({ createdAt })).toBe(false);
  });

  it("accepts a string timestamp (better-auth sometimes serializes Date as ISO string)", () => {
    const createdAt = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    expect(isFreshSignup({ createdAt })).toBe(true);
  });

  it("returns false when createdAt is missing", () => {
    expect(isFreshSignup({})).toBe(false);
  });

  it("returns false when createdAt is null", () => {
    expect(isFreshSignup({ createdAt: null })).toBe(false);
  });

  it("returns false when createdAt is an invalid date string", () => {
    expect(isFreshSignup({ createdAt: "not a real date" })).toBe(false);
  });
});
