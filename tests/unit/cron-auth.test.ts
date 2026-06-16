/**
 * KEEP-827: cron endpoint authorization must run in every environment (no
 * NODE_ENV bypass), fail closed when CRON_SECRET is unset, and compare the
 * bearer token in constant time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeCronRequest } from "@/lib/cron-auth";

function buildRequest(authorization?: string): Request {
  return new Request("http://localhost/api/cron/agentic-wallet-sweeper", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authorizeCronRequest", () => {
  it("authorizes a request carrying the correct bearer token", () => {
    expect(authorizeCronRequest(buildRequest("Bearer test-cron-secret"))).toBe(
      null
    );
  });

  it("rejects a request with no authorization header (401)", async () => {
    const res = authorizeCronRequest(buildRequest());
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a request with a wrong bearer token (401)", () => {
    expect(authorizeCronRequest(buildRequest("Bearer wrong"))?.status).toBe(
      401
    );
  });

  it("rejects a token that differs only in length (401)", () => {
    expect(
      authorizeCronRequest(buildRequest("Bearer test-cron-secret-extra"))
        ?.status
    ).toBe(401);
  });

  it("fails closed with 503 when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const res = authorizeCronRequest(buildRequest("Bearer anything"));
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: "Cron not configured" });
  });
});
