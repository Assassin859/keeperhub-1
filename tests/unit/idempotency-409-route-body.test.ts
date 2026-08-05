/**
 * The two idempotency 409s, asserted at the route rather than at the formatter.
 *
 * idempotency.test.ts covers `idempotencyEarlyResponse` directly, which proves
 * the body is shaped correctly but not that a route ships it. A route that
 * rebuilt the response itself, or dropped a field while adding headers, would
 * leave those tests green and still send a caller a 409 it cannot classify.
 *
 * So these go through the real handler and read the response it returns.
 *
 * Run with: pnpm vitest tests/unit/idempotency-409-route-body.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockValidateApiKey = vi.fn();
vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

const mockCheckRateLimit = vi.fn();
vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

// Spread the real module: the transfer route also calls validateTokenFields,
// and replacing the whole module wholesale removes it.
const mockValidateTransferInput = vi.fn();
vi.mock("@/app/api/execute/_lib/validate", async (importActual) => {
  const actual =
    await importActual<typeof import("@/app/api/execute/_lib/validate")>();
  return {
    ...actual,
    validateTransferInput: (...args: unknown[]) =>
      mockValidateTransferInput(...args),
  };
});

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi
    .fn()
    .mockResolvedValue({ blocked: false, limitResult: null }),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  EXECUTION_DEBT_ERROR: "Executions suspended due to unpaid overage invoice.",
}));

// The wallet lookup sits before the idempotency check on this route and reaches
// the database; null means "configured", which lets the request get far enough
// to return the 409 under test.
vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));

// The outcome is what varies per case; the formatter under it stays real, so a
// change to either the formatter or the route surfaces here.
const mockBeginIdempotentFromRequest = vi.fn();
vi.mock("@/lib/idempotency", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/idempotency")>();
  return {
    ...actual,
    beginIdempotentFromRequest: (...args: unknown[]) =>
      mockBeginIdempotentFromRequest(...args),
  };
});

// Import the route after the mocks are registered.
import { POST } from "@/app/api/execute/transfer/route";

function request(): Request {
  return new Request("http://localhost/api/execute/transfer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer kh_test",
      "Idempotency-Key": "same-key",
    },
    body: JSON.stringify({
      chainId: "8453",
      recipientAddress: "0x1234567890123456789012345678901234567890",
      amount: "0.1",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateApiKey.mockResolvedValue({
    organizationId: "org-1",
    apiKeyId: "key-1",
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockValidateTransferInput.mockReturnValue({ valid: true });
});

describe("idempotency 409 bodies, as the route emits them", () => {
  it("ships retryable true on an in-flight duplicate", async () => {
    mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "in_progress" });

    const res = await POST(request());
    const body = (await res.json()) as { code?: string; retryable?: boolean };

    expect(res.status).toBe(409);
    expect(body.code).toBe("idempotency_in_progress");
    expect(body.retryable).toBe(true);
  });

  it("ships retryable false on a key reused with a different body", async () => {
    mockBeginIdempotentFromRequest.mockResolvedValue({
      kind: "conflict",
      originalResourceId: "exec_1",
    });

    const res = await POST(request());
    const body = (await res.json()) as {
      code?: string;
      retryable?: boolean;
      originalExecutionId?: string;
    };

    expect(res.status).toBe(409);
    expect(body.code).toBe("idempotency_conflict");
    expect(body.retryable).toBe(false);
    expect(body.originalExecutionId).toBe("exec_1");
  });

  // The status is identical on both, so a caller that reads only the status
  // cannot tell an in-flight request from a spent key. This is the assertion
  // the whole change exists for.
  it("gives the two the same status and opposite dispositions", async () => {
    mockBeginIdempotentFromRequest.mockResolvedValue({ kind: "in_progress" });
    const inFlight = await POST(request());
    const inFlightBody = (await inFlight.json()) as { retryable?: boolean };

    mockBeginIdempotentFromRequest.mockResolvedValue({
      kind: "conflict",
      originalResourceId: null,
    });
    const conflict = await POST(request());
    const conflictBody = (await conflict.json()) as { retryable?: boolean };

    expect(inFlight.status).toBe(conflict.status);
    expect(inFlightBody.retryable).toBe(true);
    expect(conflictBody.retryable).toBe(false);
  });
});
