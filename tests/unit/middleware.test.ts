/**
 * Unit tests for the root CSRF middleware.
 * Pairs with the in-handler check in `lib/middleware/auth-helpers.ts`.
 * See KEEP-240.
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "@/middleware";

function make(
  pathname: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): NextRequest {
  return new NextRequest(new URL(pathname, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers: new Headers(init.headers ?? {}),
  });
}

describe("CSRF middleware", () => {
  it("passes GET requests without inspection", () => {
    const res = middleware(
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
      const res = middleware(
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
    const res = middleware(
      make("/api/workflows", {
        method: "POST",
        headers: { Authorization: "Bearer kh_test" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("treats empty Cookie: header as no cookies", () => {
    const res = middleware(
      make("/api/workflows", {
        method: "POST",
        headers: { cookie: "", origin: "https://evil.example.com" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("blocks cookie POST with untrusted origin", async () => {
    const res = middleware(
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
    const res = middleware(
      make("/api/workflows", {
        method: "POST",
        headers: { cookie: "better-auth.session_token=abc" },
      })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  it("falls back to Referer when Origin is absent", () => {
    const res = middleware(
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
    const res = middleware(
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
    const res = middleware(
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
      const res = middleware(
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
        const res = middleware(
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
      const res = middleware(
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
