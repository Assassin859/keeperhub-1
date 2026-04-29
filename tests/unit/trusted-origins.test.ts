import { describe, expect, it } from "vitest";
import { isTrustedOrigin, normaliseOrigin } from "@/lib/trusted-origins";

describe("isTrustedOrigin", () => {
  it("matches exact entries", () => {
    expect(isTrustedOrigin("http://localhost:3000")).toBe(true);
    expect(isTrustedOrigin("https://app-staging.keeperhub.com")).toBe(true);
  });

  it("matches subdomains via *.keeperhub.com", () => {
    expect(isTrustedOrigin("https://app.keeperhub.com")).toBe(true);
    expect(isTrustedOrigin("https://docs.keeperhub.com")).toBe(true);
  });

  it("matches dynamic ports on 127.0.0.1 (CLI auth callback)", () => {
    expect(isTrustedOrigin("http://127.0.0.1:55432")).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:1234")).toBe(true);
  });

  it("rejects untrusted origins", () => {
    expect(isTrustedOrigin("https://evil.example.com")).toBe(false);
    expect(isTrustedOrigin("https://keeperhub.com.evil.example")).toBe(false);
    expect(isTrustedOrigin("http://localhost:4000")).toBe(false);
  });

  it("rejects scheme mismatches", () => {
    expect(isTrustedOrigin("http://app.keeperhub.com")).toBe(false);
    expect(isTrustedOrigin("https://localhost:3000")).toBe(false);
  });

  it("rejects inputs that include a path (must be a bare origin)", () => {
    // isTrustedOrigin expects normaliseOrigin output, which strips paths.
    // This guards against accidental misuse if a caller skips normalisation.
    expect(isTrustedOrigin("https://app.keeperhub.com/foo")).toBe(false);
    expect(isTrustedOrigin("https://app.keeperhub.com/../evil")).toBe(false);
  });
});

describe("normaliseOrigin", () => {
  it("returns the origin portion of a full URL", () => {
    expect(normaliseOrigin("https://app.keeperhub.com/foo/bar?x=1")).toBe(
      "https://app.keeperhub.com"
    );
  });

  it("returns the origin when given just an origin", () => {
    expect(normaliseOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000"
    );
  });

  it("returns null for empty, null, or 'null' values", () => {
    expect(normaliseOrigin(null)).toBeNull();
    expect(normaliseOrigin(undefined)).toBeNull();
    expect(normaliseOrigin("")).toBeNull();
    expect(normaliseOrigin("null")).toBeNull();
  });

  it("returns null for unparseable values", () => {
    expect(normaliseOrigin("not a url")).toBeNull();
    expect(normaliseOrigin("/relative/path")).toBeNull();
  });
});
