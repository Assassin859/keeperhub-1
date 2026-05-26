/**
 * Smoke test for GET /api/cron/security-behavioral-scan. The deep DB
 * integration belongs in a Postgres-backed test (parallel pattern to
 * other `tests/integration/*-sweeper.test.ts`); this file covers the
 * shape contract that the cron scheduler and the Loki alert depend on:
 *
 *   - 401 when called without CRON_SECRET in non-dev/test environments
 *   - Returns BehavioralScanResponse JSON shape on success
 *   - Emits one structured `console.warn` per detected row
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSelectChain, mockCaptureMessage } = vi.hoisted(() => ({
  mockSelectChain: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    mockCaptureMessage(message, context);
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => mockSelectChain(),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "users.id", createdAt: "users.created_at" },
  workflowExecutions: {
    id: "we.id",
    userId: "we.user_id",
    workflowId: "we.workflow_id",
    startedAt: "we.started_at",
    triggerSource: "we.trigger_source",
    triggeredByCountry: "we.triggered_by_country",
  },
}));

const { GET } = await import(
  "@/app/api/cron/security-behavioral-scan/route"
);

const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
  // suppress test noise; we assert against the spy below
});

beforeEach(() => {
  warnSpy.mockClear();
  mockSelectChain.mockReset();
  mockCaptureMessage.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/cron/security-behavioral-scan", {
    method: "GET",
    headers,
  });
}

describe("security-behavioral-scan auth", () => {
  it("returns 401 in production without CRON_SECRET match", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "expected-token");
    const res = await GET(makeRequest({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 in production when CRON_SECRET is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(makeRequest({ authorization: "Bearer anything" }));
    expect(res.status).toBe(401);
  });

  it("bypasses auth in test environment", async () => {
    vi.stubEnv("NODE_ENV", "test");
    mockSelectChain.mockResolvedValueOnce([]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });
});

describe("security-behavioral-scan response shape", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
  });

  it("returns 0 events when no rows match", async () => {
    mockSelectChain.mockResolvedValueOnce([]);
    const res = await GET(makeRequest());
    const body = (await res.json()) as {
      newAccountFirstWorkflowEvents: number;
      durationMs: number;
    };
    expect(body.newAccountFirstWorkflowEvents).toBe(0);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits one structured warn and one Sentry capture per matched row", async () => {
    const userCreatedAt = new Date("2026-05-26T10:00:00Z");
    const executionStartedAt = new Date("2026-05-26T10:00:42Z");
    mockSelectChain.mockResolvedValueOnce([
      {
        userId: "user_freshly_signed_up",
        workflowId: "wf_1",
        executionId: "exec_1",
        triggerSource: "manual",
        triggeredByCountry: "US",
        userCreatedAt,
        executionStartedAt,
      },
    ]);
    const res = await GET(makeRequest());
    const body = (await res.json()) as {
      newAccountFirstWorkflowEvents: number;
    };
    expect(body.newAccountFirstWorkflowEvents).toBe(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "security.behavioral.new_account_first_workflow",
      userId: "user_freshly_signed_up",
      workflowId: "wf_1",
      executionId: "exec_1",
      triggerSource: "manual",
      triggeredByCountry: "US",
      ageSecondsSinceSignup: 42,
    });

    // Dual-emit pattern: Sentry mirrors the stdout signal so triage gets
    // both transports for free. Asserts the tag / extra shape so an
    // accidental shape change doesn't silently break Sentry grouping.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mockCaptureMessage.mock.calls[0] as [
      string,
      {
        level: string;
        tags: Record<string, string>;
        user: { id: string };
        extra: Record<string, unknown>;
      },
    ];
    expect(message).toBe("security.behavioral.new_account_first_workflow");
    expect(options).toMatchObject({
      level: "warning",
      tags: {
        security: "behavioral.new_account_first_workflow",
        trigger_source: "manual",
      },
      user: { id: "user_freshly_signed_up" },
      extra: {
        workflowId: "wf_1",
        executionId: "exec_1",
        triggeredByCountry: "US",
        ageSecondsSinceSignup: 42,
      },
    });
  });

  it("survives a Sentry transport failure without dropping the stdout signal", async () => {
    mockCaptureMessage.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    mockSelectChain.mockResolvedValueOnce([
      {
        userId: "u_1",
        workflowId: "wf_1",
        executionId: "exec_1",
        triggerSource: "manual",
        triggeredByCountry: null,
        userCreatedAt: new Date("2026-05-26T10:00:00Z"),
        executionStartedAt: new Date("2026-05-26T10:00:30Z"),
      },
    ]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    // Sentry threw but stdout still emitted -- the signal is durable.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("security-behavioral-scan auth hardening (KEEP-612 review-round-2)", () => {
  it("enforces CRON_SECRET even when NODE_ENV=test, if the secret is set", async () => {
    // The pre-fix behaviour bypassed auth in test env unconditionally.
    // After the fix, a configured secret always wins -- defends against
    // "container booted with NODE_ENV=test in prod" misconfigurations.
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CRON_SECRET", "expected-token");
    const res = await GET(makeRequest({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });
});
