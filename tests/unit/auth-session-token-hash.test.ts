import { createHash } from "node:crypto";
import type { DBAdapter, Where } from "better-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashSessionToken,
  wrapWithSessionTokenHash,
} from "@/lib/auth-session-token-hash";

const RAW = "raw-session-token-abcdef0123456789";
const HASH = createHash("sha256").update(RAW).digest("hex");
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UNSUPPORTED_OP_PATTERN = /operator "contains" is not supported/;
const NON_STRING_VALUE_PATTERN = /must have a string value/;
const NON_ARRAY_VALUE_PATTERN = /must have an array value/;

type Mock = ReturnType<typeof vi.fn>;

type AdapterMocks = {
  create: Mock;
  findOne: Mock;
  findMany: Mock;
  count: Mock;
  update: Mock;
  updateMany: Mock;
  delete: Mock;
  deleteMany: Mock;
};

function buildInner(): { inner: DBAdapter; mocks: AdapterMocks } {
  const mocks: AdapterMocks = {
    create: vi.fn(async (data) => data.data),
    findOne: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(async () => null),
    updateMany: vi.fn(async () => 0),
    delete: vi.fn(async () => undefined),
    deleteMany: vi.fn(async () => 0),
  };
  const inner: DBAdapter = {
    id: "mock",
    create: mocks.create,
    findOne: mocks.findOne,
    findMany: mocks.findMany,
    count: mocks.count,
    update: mocks.update,
    updateMany: mocks.updateMany,
    delete: mocks.delete,
    deleteMany: mocks.deleteMany,
    createSchema: undefined,
    options: undefined,
  } as unknown as DBAdapter;
  return { inner, mocks };
}

function build(): { wrapped: DBAdapter; mocks: AdapterMocks } {
  const { inner, mocks } = buildInner();
  const factory = vi.fn(() => inner) as unknown as () => DBAdapter;
  const wrappedFactory = wrapWithSessionTokenHash(factory);
  const wrapped = wrappedFactory();
  return { wrapped, mocks };
}

describe("hashSessionToken", () => {
  it("returns hex-encoded sha256", () => {
    expect(hashSessionToken(RAW)).toBe(HASH);
    expect(hashSessionToken(RAW)).toMatch(SHA256_HEX_PATTERN);
  });
});

describe("wrapWithSessionTokenHash", () => {
  let wrapped: DBAdapter;
  let mocks: AdapterMocks;

  beforeEach(() => {
    ({ wrapped, mocks } = build());
  });

  describe("create", () => {
    it("hashes the token before storage and restores raw token in result", async () => {
      mocks.create.mockImplementationOnce(
        async (data: { data: Record<string, unknown> }) => ({
          id: "sess-1",
          ...data.data,
        })
      );

      const result = await wrapped.create({
        model: "session",
        data: { token: RAW, userId: "u-1", expiresAt: new Date() },
      });

      expect(mocks.create).toHaveBeenCalledOnce();
      const stored = mocks.create.mock.calls[0][0].data;
      expect(stored.token).toBe(HASH);
      expect((result as { token: string }).token).toBe(RAW);
    });

    it("does not touch creates for other models", async () => {
      await wrapped.create({
        model: "user",
        data: { token: RAW, email: "x@y.z" },
      });
      expect(mocks.create.mock.calls[0][0].data.token).toBe(RAW);
    });

    it("passes through session creates that have no token field", async () => {
      await wrapped.create({
        model: "session",
        data: { userId: "u-1", expiresAt: new Date() },
      });
      const stored = mocks.create.mock.calls[0][0].data;
      expect(stored.token).toBeUndefined();
    });
  });

  describe("findOne", () => {
    it("hashes session token in eq where clause", async () => {
      await wrapped.findOne({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("hashes session token with explicit operator: eq", async () => {
      await wrapped.findOne({
        model: "session",
        where: [{ field: "token", value: RAW, operator: "eq" }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("does not hash where clauses on non-token fields", async () => {
      await wrapped.findOne({
        model: "session",
        where: [{ field: "id", value: RAW }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(RAW);
    });

    it("ignores findOne for non-session models", async () => {
      await wrapped.findOne({
        model: "user",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.findOne.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(RAW);
    });

    it("throws on substring operators against the token field", async () => {
      await expect(
        wrapped.findOne({
          model: "session",
          where: [{ field: "token", value: RAW, operator: "contains" }],
        })
      ).rejects.toThrow(UNSUPPORTED_OP_PATTERN);
      expect(mocks.findOne).not.toHaveBeenCalled();
    });

    it("throws on non-string values for token eq lookups", async () => {
      await expect(
        wrapped.findOne({
          model: "session",
          where: [{ field: "token", value: 12_345 }],
        })
      ).rejects.toThrow(NON_STRING_VALUE_PATTERN);
      expect(mocks.findOne).not.toHaveBeenCalled();
    });
  });

  describe("findMany", () => {
    it("hashes each value in operator: in arrays", async () => {
      const tokens = [RAW, "another-token"];
      const expected = tokens.map(hashSessionToken);
      await wrapped.findMany({
        model: "session",
        where: [{ field: "token", value: tokens, operator: "in" }],
      });
      const where = mocks.findMany.mock.calls[0][0].where as Where[];
      expect(where[0].value).toEqual(expected);
    });

    it("throws when operator: in receives a non-array value", async () => {
      await expect(
        wrapped.findMany({
          model: "session",
          where: [{ field: "token", value: RAW, operator: "in" }],
        })
      ).rejects.toThrow(NON_ARRAY_VALUE_PATTERN);
    });
  });

  describe("count", () => {
    it("hashes session token in eq where clause", async () => {
      await wrapped.count({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.count.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("passes through count for non-session models", async () => {
      await wrapped.count({
        model: "user",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.count.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(RAW);
    });
  });

  describe("update / updateMany", () => {
    it("hashes where token and any new token in the update payload", async () => {
      const newRaw = "rotated-token";
      await wrapped.update({
        model: "session",
        where: [{ field: "token", value: RAW }],
        update: { token: newRaw, expiresAt: new Date() },
      });
      const call = mocks.update.mock.calls[0][0];
      expect((call.where as Where[])[0].value).toBe(HASH);
      expect(call.update.token).toBe(hashSessionToken(newRaw));
    });

    it("updateMany hashes where clause", async () => {
      await wrapped.updateMany({
        model: "session",
        where: [{ field: "token", value: RAW }],
        update: { expiresAt: new Date() },
      });
      const where = mocks.updateMany.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });
  });

  describe("delete / deleteMany", () => {
    it("hashes session token where clauses", async () => {
      await wrapped.delete({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.delete.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });

    it("deleteMany hashes session token where clauses", async () => {
      await wrapped.deleteMany({
        model: "session",
        where: [{ field: "token", value: RAW }],
      });
      const where = mocks.deleteMany.mock.calls[0][0].where as Where[];
      expect(where[0].value).toBe(HASH);
    });
  });
});
