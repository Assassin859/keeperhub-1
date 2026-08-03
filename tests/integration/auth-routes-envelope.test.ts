/**
 * Integration tests for auth route error envelopes (KEEP-489 / FRICTION-08).
 *
 * Run with: pnpm vitest tests/integration/auth-routes-envelope.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockCheckIpRateLimit } = vi.hoisted(() => ({
  mockCheckIpRateLimit: vi.fn(),
}));

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
  getClientIp: () => "127.0.0.1",
}));

vi.mock("@/lib/rate-limit-headers", () => ({
  applyRateLimitHeaders: <T extends Response>(response: T): T => response,
}));

vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordScanIntent: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      set: vi.fn(),
      get: vi.fn(),
    })
  ),
}));

import { POST as scanIntentPost } from "@/app/api/auth/scan-intent/route";
import { POST as strictSigninStartPost } from "@/app/api/auth/strict-signin/start/route";
import { POST as oauthTokenPost } from "@/app/api/oauth/token/route";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EnvelopeBody = {
  error: string;
  detail: string;
  request_id: string;
  hint?: string;
  docs?: string;
  code?: unknown;
  message?: unknown;
};

function buildRequest(
  url: string,
  init?: RequestInit,
  requestId?: string
): Request {
  const headers = new Headers(init?.headers);
  if (requestId) {
    headers.set("x-request-id", requestId);
  }
  return new Request(url, { ...init, headers });
}

describe("auth route error envelopes (FRICTION-08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckIpRateLimit.mockReturnValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
  });

  it("POST /api/auth/scan-intent returns invalid_input envelope for empty body", async () => {
    const response = await scanIntentPost(
      buildRequest("http://localhost/api/auth/scan-intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_input");
    expect(body.detail).toBe("intent is required");
    expect(typeof body.request_id).toBe("string");
    expect(UUID_REGEX.test(body.request_id)).toBe(true);
    expect(body.code).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  it("POST /api/auth/strict-signin/start returns envelope for missing credentials", async () => {
    const response = await strictSigninStartPost(
      buildRequest("http://localhost/api/auth/strict-signin/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com" }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("missing_credentials");
    expect(body.detail).toBe("Email and password are required");
    expect(typeof body.request_id).toBe("string");
    expect(body.code).toBeUndefined();
  });

  it("POST /api/oauth/token returns rate_limited envelope when IP limit exceeded", async () => {
    mockCheckIpRateLimit.mockReturnValue({
      allowed: false,
      retryAfter: 45,
      limit: 30,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 45,
    });

    const response = await oauthTokenPost(
      buildRequest("http://localhost/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token" }),
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("rate_limited");
    expect(body.detail).toBe("Too many requests");
    expect(typeof body.request_id).toBe("string");
  });
});
