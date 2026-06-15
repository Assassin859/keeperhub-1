import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUsersFindFirst } = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

import { isAnonymousUserId } from "@/lib/auth-anonymous-guard";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isAnonymousUserId", () => {
  it("treats a null/undefined user id as anonymous (fail closed)", async () => {
    expect(await isAnonymousUserId(null)).toBe(true);
    expect(await isAnonymousUserId(undefined)).toBe(true);
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it("treats a missing user row as anonymous (fail closed)", async () => {
    mockUsersFindFirst.mockResolvedValue(undefined);
    expect(await isAnonymousUserId("ghost")).toBe(true);
  });

  it("returns true for an isAnonymous-flagged user", async () => {
    mockUsersFindFirst.mockResolvedValue({
      isAnonymous: true,
      name: "Anonymous",
      email: "temp-1@example.com",
    });
    expect(await isAnonymousUserId("anon-1")).toBe(true);
  });

  it("returns false for a real user", async () => {
    mockUsersFindFirst.mockResolvedValue({
      isAnonymous: false,
      name: "Real",
      email: "real@example.com",
    });
    expect(await isAnonymousUserId("user-1")).toBe(false);
  });
});
