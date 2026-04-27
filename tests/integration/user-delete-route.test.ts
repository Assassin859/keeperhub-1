import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";

const {
  mockGetSession,
  mockUsersFindFirst,
  mockUserUpdateWhere,
  mockSessionDeleteWhere,
  mockApiKeyUpdateWhere,
  mockApiKeyUpdateSet,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockUsersFindFirst: vi.fn(),
  mockUserUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockSessionDeleteWhere: vi.fn().mockResolvedValue(undefined),
  mockApiKeyUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockApiKeyUpdateSet: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

// The route runs the three deactivation writes inside db.transaction;
// reproduce that by providing a `tx` shim with the same shape we expect
// the route to call. Routing-by-table-string keeps the user-update and
// org-key-update branches separate so the test can assert each
// independently.
const txStub = {
  update: vi.fn((table: unknown) => {
    if (table === "ORG_API_KEYS_TABLE") {
      return {
        set: vi.fn((value: unknown) => {
          mockApiKeyUpdateSet(value);
          return { where: mockApiKeyUpdateWhere };
        }),
      };
    }
    return { set: vi.fn(() => ({ where: mockUserUpdateWhere })) };
  }),
  delete: vi.fn(() => ({ where: mockSessionDeleteWhere })),
};

vi.mock("@/lib/db", () => ({
  db: {
    query: { users: { findFirst: mockUsersFindFirst } },
    transaction: vi.fn(
      async (cb: (tx: typeof txStub) => Promise<unknown>) => {
        await cb(txStub);
      }
    ),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "id" },
  sessions: { userId: "user_id" },
  organizationApiKeys: "ORG_API_KEYS_TABLE",
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/user/delete/route";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/user/delete", () => {
  it("revokes the user's organization API keys on deactivation", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUsersFindFirst.mockResolvedValue({
      id: USER_ID,
      isAnonymous: false,
      deactivatedAt: null,
    });

    const response = await POST(buildRequest({ confirmation: "DEACTIVATE" }));

    expect(response.status).toBe(200);
    expect(mockApiKeyUpdateSet).toHaveBeenCalledTimes(1);
    const setCall = mockApiKeyUpdateSet.mock.calls[0][0] as {
      revokedAt: Date;
    };
    expect(setCall.revokedAt).toBeInstanceOf(Date);
    expect(mockApiKeyUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it("does not revoke keys when confirmation is missing (200 never reached)", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });

    const response = await POST(buildRequest({ confirmation: "wrong" }));

    expect(response.status).toBe(400);
    expect(mockApiKeyUpdateSet).not.toHaveBeenCalled();
  });

  it("does not revoke keys when account is already deactivated", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUsersFindFirst.mockResolvedValue({
      id: USER_ID,
      isAnonymous: false,
      deactivatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const response = await POST(buildRequest({ confirmation: "DEACTIVATE" }));

    expect(response.status).toBe(400);
    expect(mockApiKeyUpdateSet).not.toHaveBeenCalled();
  });

  it("does not revoke keys when caller is unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await POST(buildRequest({ confirmation: "DEACTIVATE" }));

    expect(response.status).toBe(401);
    expect(mockApiKeyUpdateSet).not.toHaveBeenCalled();
  });
});
