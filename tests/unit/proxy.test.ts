/**
 * Unit tests for the root CSRF proxy.
 * Pairs with the in-handler check in `lib/middleware/auth-helpers.ts`.
 * See KEEP-240.
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

function make(
  pathname: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): NextRequest {
  return new NextRequest(new URL(pathname, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers: new Headers(init.headers ?? {}),
  });
}

describe("CSRF proxy", () => {
  it("passes GET requests without inspection", () => {
    const res = proxy(
      make("/api/workflows", {
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("passes HEAD and OPTIONS without inspection", () => {
    for (const method of ["HEAD", "OPTIONS"]) {
      const res = proxy(
        make("/api/workflows", {
          method,
          headers: {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
        })
      );
      expect(res.status).toBe(200);
    }
  });

  it("passes cookieless POST (Bearer/API-key callers)", () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: { Authorization: "Bearer kh_test" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("treats empty Cookie: header as no cookies", () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: { cookie: "", origin: "https://evil.example.com" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("bypasses when only non-session cookies are present (CF Access tokens)", () => {
    // Bearer/API-key callers behind Cloudflare Access carry CF cookies
    // but no better-auth session — they shouldn't be gated.
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "CF_AppSession=abc; CF_Authorization=xyz",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("bypasses when only unrelated tracking cookies are present", () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "_ga=GA1.2.123; _gid=GA1.2.456",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("enforces when session cookie is present alongside CF cookies (real browser)", async () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie:
            "CF_AppSession=abc; __Secure-better-auth.session_token=tok; _ga=x",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  it("blocks cookie POST with untrusted origin", async () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "https://evil.example.com",
        },
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  it("blocks cookie POST with missing origin and no referer", async () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: { cookie: "better-auth.session_token=abc" },
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  it("falls back to Referer when Origin is absent", () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          referer: "http://localhost:3000/some/page",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("allows trusted origin (exact match)", () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "http://localhost:3000",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("allows trusted origin (wildcard subdomain)", () => {
    const res = proxy(
      make("/api/workflows", {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=abc",
          origin: "https://app.keeperhub.com",
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it("checks PUT, PATCH, and DELETE", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = proxy(
        make("/api/workflows", {
          method,
          headers: {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
        })
      );
      expect(res.status).toBe(403);
    }
  });

  describe("exempt paths", () => {
    const exemptPaths = [
      "/api/auth/sign-in",
      "/api/auth/anything/nested",
      "/api/billing/webhooks/stripe",
      "/api/cron/agentic-wallet-sweeper",
      "/api/oauth/register",
      "/api/oauth/token",
      "/api/workflows/wf-123/webhook",
      "/api/workflows/wf-123/webhook/anything",
      "/api/mcp/workflows/some-slug/call",
    ];

    for (const path of exemptPaths) {
      it(`bypasses ${path}`, () => {
        const res = proxy(
          make(path, {
            method: "POST",
            headers: {
              cookie: "better-auth.session_token=abc",
              origin: "https://evil.example.com",
            },
          })
        );
        expect(res.status).toBe(200);
      });
    }

    it("does NOT bypass /api/workflows/wf-123 (no trailing /webhook)", () => {
      const res = proxy(
        make("/api/workflows/wf-123", {
          method: "POST",
          headers: {
            cookie: "better-auth.session_token=abc",
            origin: "https://evil.example.com",
          },
        })
      );
      expect(res.status).toBe(403);
    });
  });
});
