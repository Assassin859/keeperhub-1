import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetExecutionCountCacheForTest,
  countMonthlyExecutionsCached,
} from "@/lib/billing/execution-limit-core";

type FakeDb = { execute: ReturnType<typeof vi.fn> };

function fakeDb(): FakeDb {
  return { execute: vi.fn() };
}

// The cached wrapper only touches db.execute; the cast keeps the fake minimal.
function asDb(db: FakeDb): Parameters<typeof countMonthlyExecutionsCached>[0] {
  return db as unknown as Parameters<typeof countMonthlyExecutionsCached>[0];
}

const SINCE = new Date("2026-07-01T00:00:00.000Z");

beforeEach(() => {
  __resetExecutionCountCacheForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("countMonthlyExecutionsCached", () => {
  it("shares a single in-flight query across concurrent callers", async () => {
    const db = fakeDb();
    let resolveQuery: (rows: { count: number }[]) => void = () => {
      /* replaced below */
    };
    db.execute.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      })
    );

    const first = countMonthlyExecutionsCached(asDb(db), "org_1", SINCE);
    const second = countMonthlyExecutionsCached(asDb(db), "org_1", SINCE);
    resolveQuery([{ count: 7 }]);

    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("serves the cached count within the TTL", async () => {
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 3 }]);

    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      3
    );
    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      3
    );
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.stubEnv("BILLING_COUNT_CACHE_TTL_MS", "1");
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([{ count: 4 }]);

    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      3
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      4
    );
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per organization", async () => {
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 2 }]);

    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      1
    );
    expect(await countMonthlyExecutionsCached(asDb(db), "org_2", SINCE)).toBe(
      2
    );
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per window start so a month rollover refetches", async () => {
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 500 }])
      .mockResolvedValueOnce([{ count: 0 }]);

    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      500
    );
    const nextMonth = new Date("2026-08-01T00:00:00.000Z");
    expect(
      await countMonthlyExecutionsCached(asDb(db), "org_1", nextMonth)
    ).toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("evicts a failed refresh so the next caller retries", async () => {
    const db = fakeDb();
    db.execute
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce([{ count: 9 }]);

    await expect(
      countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)
    ).rejects.toThrow("statement timeout");
    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      9
    );
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("recomputes on every call when the TTL is 0", async () => {
    vi.stubEnv("BILLING_COUNT_CACHE_TTL_MS", "0");
    const db = fakeDb();
    db.execute
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 2 }]);

    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      1
    );
    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      2
    );
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default TTL on a malformed env value", async () => {
    vi.stubEnv("BILLING_COUNT_CACHE_TTL_MS", "30s");
    const db = fakeDb();
    db.execute.mockResolvedValue([{ count: 3 }]);

    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      3
    );
    expect(await countMonthlyExecutionsCached(asDb(db), "org_1", SINCE)).toBe(
      3
    );
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
