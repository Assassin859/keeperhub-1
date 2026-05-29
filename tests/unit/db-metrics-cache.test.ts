/**
 * Cache behaviour for updateDbMetrics().
 *
 * Context: /api/metrics/db is scraped every 30s per pod and each call
 * triggers ~35 aggregate queries (full seq scans on workflow_executions
 * and workflow_execution_logs). The cache wraps the refresh so back-to-back
 * scrapes within DB_METRICS_CACHE_TTL_MS reuse one DB round-trip and
 * concurrent scrapes share the in-flight promise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stub every helper updateDbMetrics() imports so the test never touches the
// real DB. Each stub is a vi.fn we can assert call counts on.
const stub = (returnValue: unknown): ReturnType<typeof vi.fn> =>
  vi.fn(async () => returnValue);

const dbMocks = {
  getWorkflowStatsFromDb: stub({
    totalSuccess: 0,
    totalError: 0,
    totalRunning: 0,
    totalPending: 0,
    totalCancelled: 0,
    executionsByStatusAndOrgSlug: [],
    durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    durationSum: 0,
    durationCount: 0,
  }),
  getStepStatsFromDb: stub({
    countsByType: {},
    durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0],
    durationSum: 0,
    durationCount: 0,
  }),
  getDailyActiveUsersFromDb: stub(0),
  getUserStatsFromDb: stub({
    total: 0,
    verified: 0,
    anonymous: 0,
    withWorkflows: 0,
    withIntegrations: 0,
  }),
  getOrgStatsFromDb: stub({
    total: 0,
    membersTotal: 0,
    membersByRole: {},
    invitationsPending: 0,
    withWorkflows: 0,
  }),
  getWorkflowDefinitionStatsFromDb: stub({
    total: 0,
    public: 0,
    private: 0,
    anonymous: 0,
  }),
  getScheduleStatsFromDb: stub({
    total: 0,
    enabled: 0,
    disabled: 0,
    byLastStatus: {},
  }),
  getIntegrationStatsFromDb: stub({ total: 0, managed: 0, byType: {} }),
  getInfraStatsFromDb: stub({
    apiKeysTotal: 0,
    chainsTotal: 0,
    chainsEnabled: 0,
    walletsTotal: 0,
    sessionsActive: 0,
  }),
  getUserListFromDb: stub([]),
  getOrgListFromDb: stub([]),
  getVoteStatsFromDb: stub({
    totalVotes: 0,
    totalUpvotes: 0,
    totalDownvotes: 0,
    topWorkflows: [],
    mostClonedWorkflows: [],
    topVoters: [],
  }),
  getBillingStatsFromDb: stub({
    orgsByPlan: [],
    orgsExecutions: [],
    mrrCentsByPlan: [],
    mrrCentsTotal: 0,
  }),
};

vi.mock("@/lib/metrics/db-metrics", () => dbMocks);

import {
  __resetDbMetricsCacheForTest,
  updateDbMetrics,
} from "@/lib/metrics/collectors/prometheus";

// Flush enough microtasks for refreshDbMetricsNow()'s dynamic import +
// Promise.all of 13 helpers to settle. Vitest fake timers don't drive
// microtask queues, so we just yield to the runtime.
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("updateDbMetrics TTL cache", () => {
  const originalTtl = process.env.DB_METRICS_CACHE_TTL_MS;

  beforeEach(() => {
    __resetDbMetricsCacheForTest();
    for (const fn of Object.values(dbMocks)) {
      fn.mockClear();
    }
  });

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.DB_METRICS_CACHE_TTL_MS;
    } else {
      process.env.DB_METRICS_CACHE_TTL_MS = originalTtl;
    }
  });

  it("hits the DB once when called twice inside the TTL window", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await updateDbMetrics();
      vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
      await updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);
    expect(dbMocks.getBillingStatsFromDb).toHaveBeenCalledTimes(1);
    expect(dbMocks.getStepStatsFromDb).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL elapses", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await updateDbMetrics();
      vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
      await updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(2);
    expect(dbMocks.getBillingStatsFromDb).toHaveBeenCalledTimes(2);
  });

  it("disables caching when DB_METRICS_CACHE_TTL_MS=0", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "0";

    await updateDbMetrics();
    await updateDbMetrics();
    await updateDbMetrics();

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent callers into one DB round-trip", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    let resolveWorkflow: ((value: unknown) => void) | undefined;
    dbMocks.getWorkflowStatsFromDb.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkflow = resolve;
        })
    );

    const first = updateDbMetrics();
    const second = updateDbMetrics();

    // Drain enough microtasks that the dynamic import inside
    // refreshDbMetricsNow has resolved and Promise.all has started its
    // 13 helper calls, before we assert how many of them fired.
    await flushMicrotasks();

    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);

    resolveWorkflow?.({
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      durationSum: 0,
      durationCount: 0,
    });

    await Promise.all([first, second]);
    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight refresh even after the TTL has elapsed", async () => {
    // Guards against the cache amplifying load when a refresh under DB
    // stress takes longer than the TTL: the second scrape must share the
    // first in-flight refresh instead of starting a concurrent one.
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    let resolveWorkflow: ((value: unknown) => void) | undefined;
    dbMocks.getWorkflowStatsFromDb.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorkflow = resolve;
        })
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let first: Promise<void>;
    let second: Promise<void>;
    try {
      first = updateDbMetrics();
      // Let the dynamic import and Promise.all reach the controlled mock
      // so resolveWorkflow gets bound before we manipulate it below.
      await flushMicrotasks();
      // Advance well past the TTL while the first refresh is still hanging.
      vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
      second = updateDbMetrics();
    } finally {
      vi.useRealTimers();
    }

    resolveWorkflow?.({
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      durationSum: 0,
      durationCount: 0,
    });

    await Promise.all([first, second]);
    expect(dbMocks.getWorkflowStatsFromDb).toHaveBeenCalledTimes(1);
  });

  it("clears the cache slot on rejection so the next call retries", async () => {
    process.env.DB_METRICS_CACHE_TTL_MS = "60000";

    // Silence the expected error log so the test output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // noop
    });

    dbMocks.getWorkflowStatsFromDb.mockRejectedValueOnce(
      new Error("simulated DB outage")
    );

    // First call: refresh rejects internally; the cache wrapper logs and
    // returns a resolved promise to the caller, but evicts the slot so a
    // subsequent call retries instead of seeing the failed entry pinned
    // for the full TTL.
    await updateDbMetrics();
    await updateDbMetrics();

    expect(
      dbMocks.getWorkflowStatsFromDb.mock.calls.length
    ).toBeGreaterThanOrEqual(2);

    errSpy.mockRestore();
  });
});
