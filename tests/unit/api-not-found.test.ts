/**
 * Catch-all 404 handler returns the canonical structured envelope.
 *
 * The envelope shape itself is exercised by api-error-envelope.test.ts;
 * this file pins the catch-all's contract: every HTTP method returns a
 * 404 with {error:"not_found", detail:"Route <METHOD> <path> not found",
 * request_id:<string>}, Content-Type: application/json, and
 * Cache-Control: no-store.
 *
 * Routing precedence (more specific routes win over [...slug]) is a
 * property of the Next.js App Router, not of this file; it is exercised
 * end-to-end by the live HEAD check in deploy-keeperhub.yaml. The repo's
 * existing /api/auth/[...all] and /api/execute/[...slug] catch-alls live
 * at deeper segments and therefore take precedence by construction.
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
} from "@/app/api/[...slug]/route";

function buildRequest(
  method: string,
  path: string,
  extraHeaders?: HeadersInit
) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: extraHeaders,
  });
}

const HANDLERS = {
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
  HEAD,
  OPTIONS,
} as const;

describe("/api/[...slug] catch-all 404", () => {
  for (const [method, handler] of Object.entries(HANDLERS)) {
    it(`${method} unknown route returns structured not_found envelope`, async () => {
      const path = "/api/this-route-does-not-exist";
      const response = handler(buildRequest(method, path));
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json"
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
      expect(body.detail).toBe(`Route ${method} ${path} not found`);
      expect(typeof body.request_id).toBe("string");
      expect((body.request_id as string).length).toBeGreaterThan(0);
    });
  }

  it("echoes inbound x-request-id so clients can correlate", async () => {
    const response = GET(
      buildRequest("GET", "/api/missing", {
        "x-request-id": "trace-abc-123",
      })
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.request_id).toBe("trace-abc-123");
    expect(response.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  it("encodes the request method and path verbatim in detail", async () => {
    const response = POST(
      buildRequest("POST", "/api/me", { "content-type": "application/json" })
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.detail).toBe("Route POST /api/me not found");
  });
});
