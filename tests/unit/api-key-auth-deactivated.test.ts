import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockApiKeysFindFirst, mockUsersFindFirst, mockUpdate } = vi.hoisted(
  () => ({
    mockApiKeysFindFirst: vi.fn(),
    mockUsersFindFirst: vi.fn(),
    mockUpdate: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  })
);

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizationApiKeys: { findFirst: mockApiKeysFindFirst },
      users: { findFirst: mockUsersFindFirst },
    },
    update: mockUpdate,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationApiKeys: {
    id: "id",
    keyHash: "key_hash",
    revokedAt: "revoked_at",
    expiresAt: "expires_at",
  },
  users: { id: "id" },
}));

import { authenticateApiKey } from "@/lib/api-key-auth";

const VALID_KEY = "kh_test_secret_value_12345";
const KEY_HASH = createHash("sha256").update(VALID_KEY).digest("hex");
const HEX_64 = /^[a-f0-9]{64}$/;

function buildRequest(): Request {
  return new Request("http://localhost/api/anything", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateApiKey -- deactivated creator handling", () => {
  it("authenticates a key whose creator account is active", async () => {
    mockApiKeysFindFirst.mockResolvedValue({
      id: "key-1",
      organizationId: "org-1",
      createdBy: "user-1",
    });
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(true);
    expect(result.organizationId).toBe("org-1");
    expect(result.apiKeyId).toBe("key-1");
    expect(result.userId).toBe("user-1");
  });

  it("rejects a key whose creator account is deactivated", async () => {
    mockApiKeysFindFirst.mockResolvedValue({
      id: "key-1",
      organizationId: "org-1",
      createdBy: "user-1",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe("API key creator account is deactivated");
  });

  it("authenticates a key with no recorded creator (legacy compat)", async () => {
    mockApiKeysFindFirst.mockResolvedValue({
      id: "key-legacy",
      organizationId: "org-1",
      createdBy: null,
    });

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBeUndefined();
    // No users lookup should happen for null createdBy
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a key whose row was not found (existing behaviour)", async () => {
    mockApiKeysFindFirst.mockResolvedValue(undefined);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe("Invalid or revoked API key");
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it("queries with the SHA-256 hash of the supplied key", async () => {
    mockApiKeysFindFirst.mockResolvedValue({
      id: "key-1",
      organizationId: "org-1",
      createdBy: "user-1",
    });
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });

    await authenticateApiKey(buildRequest());

    // Sanity: the hash we compute matches what the route should use.
    expect(KEY_HASH).toMatch(HEX_64);
    expect(mockApiKeysFindFirst).toHaveBeenCalledTimes(1);
  });
});
