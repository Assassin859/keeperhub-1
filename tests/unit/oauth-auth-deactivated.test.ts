import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUsersFindFirst } = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));

const TEST_SECRET = "test-secret-32-bytes-long-enough-for-hs256";
process.env.OAUTH_JWT_SECRET = TEST_SECRET;

import {
  authenticateOAuthToken,
  createAccessToken,
} from "@/lib/mcp/oauth-auth";

async function buildRequestWithToken(token: string): Promise<Request> {
  return new Request("http://localhost/api/anything", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateOAuthToken -- deactivated user handling", () => {
  it("authenticates a token whose subject is an active user", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user-1");
    expect(result.organizationId).toBe("org-1");
  });

  it("rejects a token whose subject has been deactivated", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe("User account is deactivated");
  });

  it("rejects a kh_-prefixed bearer token (handled by API-key auth instead)", async () => {
    const result = await authenticateOAuthToken(
      await buildRequestWithToken("kh_should_not_be_handled_here")
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a token with an invalid signature without touching the DB", async () => {
    const result = await authenticateOAuthToken(
      await buildRequestWithToken("not.a.valid.jwt")
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });
});
