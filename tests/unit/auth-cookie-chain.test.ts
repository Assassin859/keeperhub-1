import { describe, expect, test } from "vitest";
import {
  readAllSetCookies,
  setCookiesToCookieHeader,
} from "@/lib/auth-cookie-chain";

describe("readAllSetCookies", () => {
  test("returns every Set-Cookie as a separate string", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    expect(readAllSetCookies(h)).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  test("returns empty array when no Set-Cookie present", () => {
    expect(readAllSetCookies(new Headers())).toEqual([]);
  });
});

describe("setCookiesToCookieHeader", () => {
  test("strips attributes and joins name=value pairs with semicolons", () => {
    const out = setCookiesToCookieHeader([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; HttpOnly; Secure",
    ]);
    expect(out).toBe("a=1; b=2");
  });

  test("ignores empty entries", () => {
    expect(setCookiesToCookieHeader([])).toBe("");
    expect(setCookiesToCookieHeader([""])).toBe("");
    expect(setCookiesToCookieHeader(["a=1; Path=/", ""])).toBe("a=1");
  });

  // Regression: in production Better Auth uses the `__Secure-*` cookie
  // prefix (useSecureCookies: true). The previous regex-based split
  // matched cookie names against [A-Za-z]... which does NOT match a
  // leading underscore, so both cookies were collapsed into one and
  // only the session-clearing pair survived. verifyTOTP then threw
  // Invalid two factor cookie because the two_factor cookie was
  // dropped from the chained Cookie header.
  test("preserves __Secure-prefixed cookie names through the chain", () => {
    const out = setCookiesToCookieHeader([
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Secure-better-auth.two_factor=signed-value; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(out).toContain("__Secure-better-auth.two_factor=signed-value");
    expect(out).toBe(
      "__Secure-better-auth.session_token=; __Secure-better-auth.two_factor=signed-value"
    );
  });
});

describe("end-to-end chain (Headers -> Cookie header)", () => {
  test("a Headers object populated by Better Auth's twoFactor after-hook in production chains into a Cookie header that includes the two_factor cookie", () => {
    // Simulates what auth.api.signInEmail returns for a TOTP-enrolled
    // user in production: deleteSessionCookie + setSignedCookie
    // appended to the response Headers in that order. Both must
    // survive into the Cookie header handed to auth.api.verifyTOTP.
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"
    );
    headers.append(
      "set-cookie",
      "__Secure-better-auth.two_factor=signed-token; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax"
    );
    const cookieHeader = setCookiesToCookieHeader(readAllSetCookies(headers));
    expect(cookieHeader).toContain(
      "__Secure-better-auth.two_factor=signed-token"
    );
  });
});
