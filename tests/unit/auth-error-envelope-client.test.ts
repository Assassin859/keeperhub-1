import { describe, expect, it } from "vitest";
import {
  authErrorCode,
  authErrorMessage,
} from "@/lib/auth/auth-error-envelope-client";

describe("auth error envelope client helpers", () => {
  it("authErrorCode prefers error over legacy code", () => {
    expect(authErrorCode({ error: "invalid_totp", code: "legacy" })).toBe(
      "invalid_totp"
    );
  });

  it("authErrorCode falls back to legacy code", () => {
    expect(authErrorCode({ code: "invalid_email_otp" })).toBe(
      "invalid_email_otp"
    );
  });

  it("authErrorMessage prefers detail for user-facing text", () => {
    expect(
      authErrorMessage(
        { error: "invalid_signin", detail: "Invalid sign-in" },
        "fallback"
      )
    ).toBe("Invalid sign-in");
  });

  it("authErrorMessage falls back to error then default", () => {
    expect(
      authErrorMessage({ error: "invalid_signin" }, "Sign in failed")
    ).toBe("invalid_signin");
    expect(authErrorMessage({}, "Sign in failed")).toBe("Sign in failed");
  });
});
