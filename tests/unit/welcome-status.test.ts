// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasSeenWelcome,
  isContinueAsGuest,
  markContinueAsGuest,
  markOnboardingComplete,
  markWelcomeSeen,
} from "@/lib/welcome-status";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("welcome flags", () => {
  it("welcome-seen defaults to false and flips once marked", () => {
    expect(hasSeenWelcome()).toBe(false);
    markWelcomeSeen();
    expect(hasSeenWelcome()).toBe(true);
  });

  it("continue-as-guest defaults to false and flips once marked", () => {
    expect(isContinueAsGuest()).toBe(false);
    markContinueAsGuest();
    expect(isContinueAsGuest()).toBe(true);
  });

  it("the two flags are independent", () => {
    markWelcomeSeen();
    expect(isContinueAsGuest()).toBe(false);
  });
});

describe("markOnboardingComplete", () => {
  it("POSTs to the completion endpoint", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    markOnboardingComplete();

    expect(fetchMock).toHaveBeenCalledWith("/api/user/onboarding/complete", {
      method: "POST",
    });
  });

  it("swallows a failed request", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(() => markOnboardingComplete()).not.toThrow();
  });
});
