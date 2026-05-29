import { describe, expect, it } from "vitest";
import { isKh001SessionBackstop } from "@/lib/security/session-backstop";

describe("isKh001SessionBackstop", () => {
  it("matches a top-level KH001 SQLSTATE", () => {
    expect(isKh001SessionBackstop({ code: "KH001" })).toBe(true);
  });

  it("matches KH001 on a nested cause (Better Auth wrapping)", () => {
    // Better Auth wraps adapter errors; the postgres SQLSTATE lands on cause.
    const wrapped = new Error("Failed to create session");
    (wrapped as Error & { cause: unknown }).cause = { code: "KH001" };
    expect(isKh001SessionBackstop(wrapped)).toBe(true);
  });

  it("matches KH001 two causes deep", () => {
    const err = {
      message: "outer",
      cause: { message: "mid", cause: { code: "KH001" } },
    };
    expect(isKh001SessionBackstop(err)).toBe(true);
  });

  it("falls back to the trigger message when the SQLSTATE was stripped", () => {
    expect(
      isKh001SessionBackstop({
        message: "Session owner is deactivated; new sessions are not allowed.",
      })
    ).toBe(true);
  });

  it("matches the message fragment on a nested cause", () => {
    expect(
      isKh001SessionBackstop({
        message: "db error",
        cause: { message: "Session owner is deactivated" },
      })
    ).toBe(true);
  });

  it("does not match an unrelated postgres error", () => {
    expect(isKh001SessionBackstop({ code: "23505" })).toBe(false);
  });

  it("does not match an unrelated message", () => {
    expect(
      isKh001SessionBackstop({ message: "duplicate key value violates unique" })
    ).toBe(false);
  });

  it("handles null / undefined / primitive without throwing", () => {
    expect(isKh001SessionBackstop(null)).toBe(false);
    expect(isKh001SessionBackstop(undefined)).toBe(false);
    expect(isKh001SessionBackstop("KH001")).toBe(false);
  });

  it("terminates on a self-referential cause cycle (bounded walk)", () => {
    const a: { code: string; cause?: unknown } = { code: "nope" };
    a.cause = a;
    expect(isKh001SessionBackstop(a)).toBe(false);
  });
});
