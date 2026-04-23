/**
 * Unit tests for `incrementAndCheck` (Phase 37 Wave 5 Task 20, fix #7).
 *
 * Strategy: the production code uses a single raw SQL statement via
 * `db.execute(sql`INSERT ... ON CONFLICT ... RETURNING request_count`)`.
 * We mock `@/lib/db` with an in-memory `Map<"key|bucket_start", number>`
 * that emulates the UPSERT+increment semantics and returns the new count
 * as `[{ request_count: n }]` (postgres-js returns the rows array directly
 * from `db.execute`).
 *
 * To recover the `key` argument from the `sql`-tagged template, we read
 * the top-level `queryChunks` on the SQL value: drizzle stores primitive
 * `${key}` interpolations inline as plain JS strings while table/column
 * references are class instances (`PgTable` / `PgColumn`). Filtering on
 * `typeof chunk === "string"` gives us the user-supplied params in order,
 * without needing to reach into drizzle internals for the `Param` class.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted in-memory store
// ---------------------------------------------------------------------------

type Store = Map<string, number>;

const { store } = vi.hoisted(() => ({ store: new Map<string, number>() }));

function truncateToHour(date: Date): string {
  const copy = new Date(date);
  copy.setMinutes(0, 0, 0);
  return copy.toISOString();
}

/**
 * Walk a drizzle `SQL` value's top-level `queryChunks` and collect
 * primitive string interpolations in source order. For our template
 * `sql`INSERT INTO ${table} (...) VALUES (${key}, ...) ...``, drizzle
 * stores table/column refs as class instances (PgTable/PgColumn) and
 * embeds primitive `${key}` values directly as JS strings. Filtering on
 * `typeof chunk === "string"` yields the user-supplied params in order.
 */
function extractStringInterpolations(node: unknown): string[] {
  if (!node || typeof node !== "object") {
    return [];
  }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    return [];
  }
  const values: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      values.push(chunk);
    }
  }
  return values;
}

function upsertAndIncrement(
  storeRef: Store,
  key: string,
  bucketStart: string
): number {
  const composite = `${key}|${bucketStart}`;
  const next = (storeRef.get(composite) ?? 0) + 1;
  storeRef.set(composite, next);
  return next;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    execute: vi.fn((sqlValue: unknown) => {
      const interpolations = extractStringInterpolations(sqlValue);
      // First string interpolation in the INSERT ... VALUES (${key}, ...)
      // is the rate-limit key.
      const key = interpolations[0] ?? "";
      const bucketStart = truncateToHour(new Date());
      const count = upsertAndIncrement(store, key, bucketStart);
      return Promise.resolve([{ request_count: count }]);
    }),
  },
}));

// Import AFTER mocks so the module under test picks up the mocked `db`.
const { incrementAndCheck } = await import("@/lib/agentic-wallet/rate-limit");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rate-limit incrementAndCheck (Phase 37 fix #7)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("returns allowed: true on first hit", async () => {
    const r = await incrementAndCheck("provision:1.2.3.4", 5);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it("rejects after limit reached in same hour bucket", async () => {
    for (const _ of Array.from({ length: 5 })) {
      const r = await incrementAndCheck("provision:1.2.3.4", 5);
      expect(r.allowed).toBe(true);
    }
    const sixth = await incrementAndCheck("provision:1.2.3.4", 5);
    expect(sixth.allowed).toBe(false);
    if (sixth.allowed === false) {
      expect(sixth.retryAfter).toBeGreaterThan(0);
      expect(sixth.retryAfter).toBeLessThanOrEqual(3600);
      expect(sixth.count).toBe(6);
    }
  });

  it("isolates buckets by key", async () => {
    for (const _ of Array.from({ length: 5 })) {
      await incrementAndCheck("provision:1.2.3.4", 5);
    }
    const r = await incrementAndCheck("provision:5.6.7.8", 5);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it("retryAfter is bounded to at least 1 second at the hour boundary", async () => {
    // Pin wall-clock to XX:59:59.999 so `3600 - (59*60 + 59)` = 1. The
    // production `Math.max(1, ...)` guard also covers the race where the
    // second rolls to 3600 between the SQL execute and the Date read.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T12:59:59.999Z"));
      for (const _ of Array.from({ length: 6 })) {
        await incrementAndCheck("provision:edge", 5);
      }
      const r = await incrementAndCheck("provision:edge", 5);
      expect(r.allowed).toBe(false);
      if (r.allowed === false) {
        expect(r.retryAfter).toBeGreaterThanOrEqual(1);
        expect(r.retryAfter).toBeLessThanOrEqual(3600);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps incrementing over-limit (no locked-out state by design)", async () => {
    // The UPSERT increments on every call even after the limit is
    // exceeded. Callers see `allowed: false` with a monotonically growing
    // `count`. This is intentional -- the cron sweeper is the only state
    // resetter (and it only deletes rows >24h old).
    for (const _ of Array.from({ length: 5 })) {
      await incrementAndCheck("provision:grow", 5);
    }
    const seventh = await incrementAndCheck("provision:grow", 5);
    const eighth = await incrementAndCheck("provision:grow", 5);
    const ninth = await incrementAndCheck("provision:grow", 5);
    expect(seventh.allowed).toBe(false);
    expect(eighth.allowed).toBe(false);
    expect(ninth.allowed).toBe(false);
    if (
      seventh.allowed === false &&
      eighth.allowed === false &&
      ninth.allowed === false
    ) {
      expect(seventh.count).toBeLessThan(eighth.count);
      expect(eighth.count).toBeLessThan(ninth.count);
    }
  });
});
