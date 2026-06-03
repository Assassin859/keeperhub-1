import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockHeaders, mockLimit } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockHeaders: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mockHeaders }));
vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
// db.select(...).from(...).where(...).limit(1) -> mockLimit()
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: mockLimit }) }),
    }),
  },
}));

import { gateRequestIp } from "@/lib/security/login-risk";

type RedisLike = {
  get: (key: string) => Promise<unknown>;
  set: (...args: unknown[]) => Promise<unknown>;
};

function headersWith(values: Record<string, string>): {
  get: (key: string) => string | null;
} {
  return { get: (key: string) => values[key.toLowerCase()] ?? null };
}

// CF-Connecting-IP 9.9.9.9 normalizes (/24) to 9.9.9.0.
const CF_HEADERS = { "cf-connecting-ip": "9.9.9.9", "cf-ipcountry": "DE" };
const TRUST_KEY = "local:trust:u1:9.9.9.0";

beforeEach(() => {
  mockGetRedis.mockReset();
  mockHeaders.mockReset();
  mockLimit.mockReset();
  mockHeaders.mockResolvedValue(headersWith(CF_HEADERS));
});

describe("gateRequestIp read-through Redis cache", () => {
  it("returns no_ip when no client IP can be resolved (no DB, no Redis)", async () => {
    mockHeaders.mockResolvedValue(headersWith({}));
    mockGetRedis.mockReturnValue(null);

    expect(await gateRequestIp("u1")).toEqual({ kind: "no_ip" });
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("serves trusted from a Redis hit without touching the DB", async () => {
    const get = vi.fn().mockResolvedValue("1");
    mockGetRedis.mockReturnValue({ get, set: vi.fn() } as RedisLike);

    expect(await gateRequestIp("u1")).toEqual({ kind: "trusted" });
    expect(get).toHaveBeenCalledWith(TRUST_KEY);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("on a Redis miss reads the DB, returns trusted, and re-caches", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const set = vi.fn().mockResolvedValue("OK");
    mockGetRedis.mockReturnValue({ get, set } as RedisLike);
    mockLimit.mockResolvedValue([{ id: "row-1" }]);

    expect(await gateRequestIp("u1")).toEqual({ kind: "trusted" });
    expect(mockLimit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(set).toHaveBeenCalledWith(TRUST_KEY, "1", "EX", 300)
    );
  });

  it("returns untrusted (with ip + country) when the DB has no row", async () => {
    const get = vi.fn().mockResolvedValue(null);
    mockGetRedis.mockReturnValue({ get, set: vi.fn() } as RedisLike);
    mockLimit.mockResolvedValue([]);

    expect(await gateRequestIp("u1")).toEqual({
      kind: "untrusted",
      ip: "9.9.9.0",
      country: "DE",
    });
  });

  it("falls back to the DB when Redis is not configured", async () => {
    mockGetRedis.mockReturnValue(null);
    mockLimit.mockResolvedValue([{ id: "row-1" }]);

    expect(await gateRequestIp("u1")).toEqual({ kind: "trusted" });
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the DB when the Redis read throws", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    mockGetRedis.mockReturnValue({ get, set: vi.fn() } as RedisLike);
    mockLimit.mockResolvedValue([{ id: "row-1" }]);

    expect(await gateRequestIp("u1")).toEqual({ kind: "trusted" });
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });
});
