/**
 * KEEP-489: REST APIs return a structured `{error, detail, hint, docs,
 * request_id}` envelope so clients branch on `error` (a stable snake_case
 * code) instead of regex-matching the prose message. Multiple hackathon
 * teams independently reverse-engineered defensive parsers; this contract
 * removes that need.
 */
import { describe, expect, it } from "vitest";
import { apiError, ApiErrorCodes } from "@/lib/errors/api-envelope";

describe("apiError envelope (KEEP-489)", () => {
  it("emits {error, detail} with the requested HTTP status", async () => {
    const response = apiError({
      status: 401,
      code: ApiErrorCodes.UNAUTHORIZED,
      detail: "Missing bearer token",
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({
      error: "unauthorized",
      detail: "Missing bearer token",
    });
  });

  it("includes optional hint, docs, and request_id when provided", async () => {
    const response = apiError({
      status: 404,
      code: "wallet_not_configured",
      detail: "No wallet provisioned for chain 8453 in org X",
      hint: "POST /api/integrations/wallet to provision",
      docs: "https://docs.keeperhub.com/wallets",
      requestId: "req_abc123",
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({
      error: "wallet_not_configured",
      detail: "No wallet provisioned for chain 8453 in org X",
      hint: "POST /api/integrations/wallet to provision",
      docs: "https://docs.keeperhub.com/wallets",
      request_id: "req_abc123",
    });
  });

  it("omits optional fields when not provided (clients can rely on key presence)", async () => {
    const body = (await apiError({
      status: 400,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "Bad request",
    }).json()) as Record<string, unknown>;
    expect(body.hint).toBeUndefined();
    expect(body.docs).toBeUndefined();
    expect(body.request_id).toBeUndefined();
  });

  it("preserves caller-supplied headers", () => {
    const response = apiError({
      status: 429,
      code: ApiErrorCodes.RATE_LIMITED,
      detail: "Too many requests",
      headers: { "Retry-After": "60" },
    });
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("exports canonical codes used across routes", () => {
    expect(ApiErrorCodes.UNAUTHORIZED).toBe("unauthorized");
    expect(ApiErrorCodes.INSUFFICIENT_SCOPE).toBe("insufficient_scope");
    expect(ApiErrorCodes.NOT_FOUND).toBe("not_found");
    expect(ApiErrorCodes.INVALID_INPUT).toBe("invalid_input");
    expect(ApiErrorCodes.CONFLICT).toBe("conflict");
    expect(ApiErrorCodes.RATE_LIMITED).toBe("rate_limited");
    expect(ApiErrorCodes.INTERNAL_ERROR).toBe("internal_error");
  });
});
