import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockAuth, mockSelect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/db", () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/workflows/route";

/**
 * A chainable stub standing in for the drizzle builder. It records the calls
 * the route makes so the test can assert on the query that was built rather
 * than on a database, and resolves to `rows` when awaited.
 */
function queryStub(rows: unknown[]) {
  const calls: { limit?: number; offset?: number; orderBy: number } = {
    orderBy: 0,
  };
  const builder: Record<string, unknown> = {
    from: () => builder,
    where: () => builder,
    orderBy: (...args: unknown[]) => {
      calls.orderBy = args.length;
      return builder;
    },
    limit: (n: number) => {
      calls.limit = n;
      return builder;
    },
    offset: (n: number) => {
      calls.offset = n;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) => resolve(rows),
  };
  return { builder, calls };
}

const row = (id: string) => ({
  id,
  organizationId: "org_1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const call = (url: string) => GET(new Request(url));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ organizationId: "org_1" });
});

describe("GET /api/workflows paging", () => {
  it("returns every row and no X-Total-Count when limit is absent", async () => {
    const { builder, calls } = queryStub([row("a"), row("b")]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows");

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
    expect(calls.limit).toBeUndefined();
    // The header only means something alongside a page.
    expect(res.headers.get("X-Total-Count")).toBeNull();
  });

  it("applies limit and offset, and reports the total", async () => {
    const { builder, calls } = queryStub([row("a")]);
    // First call builds the page, second counts the matching rows.
    mockSelect
      .mockReturnValueOnce(builder)
      .mockReturnValueOnce(queryStub([{ value: 900 }]).builder);

    const res = await call("https://x.test/api/workflows?limit=10&offset=20");

    expect(res.status).toBe(200);
    expect(calls.limit).toBe(10);
    expect(calls.offset).toBe(20);
    expect(res.headers.get("X-Total-Count")).toBe("900");
  });

  it("clamps limit to MAX_PAGE_SIZE", async () => {
    const { builder, calls } = queryStub([]);
    mockSelect
      .mockReturnValueOnce(builder)
      .mockReturnValueOnce(queryStub([{ value: 0 }]).builder);

    await call("https://x.test/api/workflows?limit=1000000");

    expect(calls.limit).toBe(200);
  });

  it("accepts offset=0, which is page one of every pager", async () => {
    // The regression this exists for: offset shared limit's `> 0` rule, so
    // `for (let p = 0; ; p++) fetch(?limit=50&offset=${p * 50})` 400d on its
    // first request - the one call every paging client makes.
    const { builder, calls } = queryStub([]);
    mockSelect
      .mockReturnValueOnce(builder)
      .mockReturnValueOnce(queryStub([{ value: 0 }]).builder);

    const res = await call("https://x.test/api/workflows?limit=50&offset=0");

    expect(res.status).toBe(200);
    expect(calls.offset).toBe(0);
  });

  it.each(["1e20", "99999999999999999999", "-1"])(
    "rejects offset=%s rather than letting Postgres reject it",
    async (value) => {
      // Number.isInteger(1e20) is true, so an unbounded offset reaches the
      // driver as a bigint overflow and the caller gets a raw database message.
      const { builder } = queryStub([]);
      mockSelect.mockReturnValue(builder);

      const res = await call(
        `https://x.test/api/workflows?limit=10&offset=${encodeURIComponent(value)}`
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/offset/);
    }
  );

  it.each(["0x1f4", "1e2", " 5"])(
    "rejects limit=%s, which Number() would have silently accepted",
    async (value) => {
      const { builder } = queryStub([]);
      mockSelect.mockReturnValue(builder);

      const res = await call(
        `https://x.test/api/workflows?limit=${encodeURIComponent(value)}`
      );

      expect(res.status).toBe(400);
    }
  );

  it("sorts by a total order so pages cannot overlap", async () => {
    // createdAt is not unique, so a single-column sort lets a row on a page
    // boundary appear twice while another is skipped.
    const { builder, calls } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    await call("https://x.test/api/workflows");

    expect(calls.orderBy).toBe(2);
  });

  it.each(["abc", "0", "-1", ""])(
    "rejects limit=%s rather than returning the whole list",
    async (value) => {
      const { builder } = queryStub([]);
      mockSelect.mockReturnValue(builder);

      const res = await call(
        `https://x.test/api/workflows?limit=${encodeURIComponent(value)}`
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/limit/);
    }
  );

  it("rejects offset without limit", async () => {
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows?offset=100");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/offset requires limit/);
  });
});
