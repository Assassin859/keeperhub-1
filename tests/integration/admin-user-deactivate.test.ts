import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "kha_test-admin-secret-12345";
const TEST_USER_ID = "user-abc123";

type MockUser = { id: string; deactivatedAt: Date | null } | undefined;

let mockUserForSelect: MockUser = undefined;
let mockShouldThrow = false;

vi.mock("@/lib/db", () => {
  const txMock = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mockUserForSelect ? [mockUserForSelect] : [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  };

  return {
    db: {
      transaction: vi.fn((fn: (tx: typeof txMock) => Promise<unknown>) => {
        if (mockShouldThrow) throw new Error("DB error");
        return fn(txMock);
      }),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", deactivatedAt: "deactivated_at", updatedAt: "updated_at" },
  sessions: { userId: "user_id" },
  organizationApiKeys: { createdBy: "created_by", revokedAt: "revoked_at" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/admin/users/[userId]/deactivate/route";

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/admin/users/user-abc123/deactivate", {
    method: "POST",
    headers,
  });
}

function makeContext(userId = TEST_USER_ID) {
  return { params: Promise.resolve({ userId }) };
}

describe("POST /api/admin/users/:userId/deactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserForSelect = undefined;
    mockShouldThrow = false;
    vi.stubEnv("KH_ADMIN_SECRET", TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("authentication", () => {
    it("returns 401 when KH_ADMIN_SECRET is not configured", async () => {
      vi.stubEnv("KH_ADMIN_SECRET", "");
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header is missing", async () => {
      const res = await POST(makeRequest(), makeContext());
      expect(res.status).toBe(401);
    });

    it("returns 401 when secret is wrong", async () => {
      const res = await POST(makeRequest("wrong-secret"), makeContext());
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Invalid KH admin secret");
    });
  });

  describe("happy path", () => {
    it("deactivates the user and returns userId and deactivatedAt", async () => {
      mockUserForSelect = { id: TEST_USER_ID, deactivatedAt: null };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.userId).toBe(TEST_USER_ID);
      expect(data.deactivatedAt).toBeDefined();
    });
  });

  describe("error cases", () => {
    it("returns 404 when user does not exist", async () => {
      mockUserForSelect = undefined;

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("User not found");
    });

    it("returns 409 when user is already deactivated", async () => {
      mockUserForSelect = { id: TEST_USER_ID, deactivatedAt: new Date() };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe("User is already deactivated");
    });

    it("returns 500 on database error", async () => {
      mockShouldThrow = true;
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Internal server error");
    });
  });
});
