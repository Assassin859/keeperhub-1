import { getCookies } from "better-auth/cookies";
import { describe, expect, it } from "vitest";
import {
  hasSessionCookie,
  isTrustedOrigin,
  normaliseOrigin,
  SESSION_COOKIE_NAME_SUBSTRING,
} from "@/lib/trusted-origins";

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

describe("hasSessionCookie", () => {
  function headers(cookie?: string): Headers {
    return new Headers(cookie === undefined ? {} : { cookie });
  }

  it("returns false when no Cookie header is present", () => {
    expect(hasSessionCookie(headers())).toBe(false);
  });

  it("returns false when Cookie header is empty", () => {
    expect(hasSessionCookie(headers(""))).toBe(false);
  });

  it("returns false when only non-session cookies are present", () => {
    expect(
      hasSessionCookie(headers("CF_AppSession=a; CF_Authorization=b"))
    ).toBe(false);
    expect(hasSessionCookie(headers("_ga=GA1.2.123; _gid=GA1.2.456"))).toBe(
      false
    );
    expect(hasSessionCookie(headers("sidebar-collapsed=false"))).toBe(false);
  });

  it("returns true for the dev cookie name (no Secure prefix)", () => {
    expect(hasSessionCookie(headers("better-auth.session_token=abc"))).toBe(
      true
    );
  });

  it("returns true for the prod cookie name (Secure prefix)", () => {
    expect(
      hasSessionCookie(headers("__Secure-better-auth.session_token=abc"))
    ).toBe(true);
  });

  it("returns true when session cookie is mixed with unrelated cookies", () => {
    expect(
      hasSessionCookie(
        headers(
          "CF_AppSession=a; __Secure-better-auth.session_token=tok; _ga=x"
        )
      )
    ).toBe(true);
  });
});

describe("better-auth cookie name pinning", () => {
  // If better-auth ever renames its session cookie, our substring check in
  // proxy.ts and auth-helpers.ts becomes a no-op (silently disabling the
  // CSRF protection). This test imports the actual better-auth helper used
  // to generate cookie names and asserts our substring still matches, so a
  // future upgrade fails CI rather than silently weakening the gate.
  // See KEEP-240.

  it("matches the dev cookie name better-auth generates from default options", () => {
    const cookies = getCookies({} as Parameters<typeof getCookies>[0]);
    expect(cookies.sessionToken.name).toBe("better-auth.session_token");
    expect(`${cookies.sessionToken.name}=`).toContain(
      SESSION_COOKIE_NAME_SUBSTRING
    );
  });

  it("matches the prod cookie name better-auth generates with useSecureCookies", () => {
    const cookies = getCookies({
      advanced: { useSecureCookies: true },
    } as Parameters<typeof getCookies>[0]);
    expect(cookies.sessionToken.name).toBe(
      "__Secure-better-auth.session_token"
    );
    expect(`${cookies.sessionToken.name}=`).toContain(
      SESSION_COOKIE_NAME_SUBSTRING
    );
  });
});
