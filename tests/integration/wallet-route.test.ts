import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}));

const mockGetActiveOrgId = vi.fn();

vi.mock("@/lib/middleware/org-context", () => ({
  getActiveOrgId: (...args: unknown[]) => mockGetActiveOrgId(...args),
}));

const mockWalletSelectWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: (...args: unknown[]) => mockWalletSelectWhere(...args),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationWallets: {
    id: "id",
    userId: "user_id",
    email: "email",
    organizationId: "organization_id",
    provider: "provider",
    paraWalletId: "para_wallet_id",
    turnkeyWalletId: "turnkey_wallet_id",
    walletAddress: "wallet_address",
    createdAt: "created_at",
    isActive: "is_active",
  },
  integrations: {},
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "EXTERNAL_SERVICE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/turnkey/turnkey-client", () => ({
  createTurnkeyWallet: vi.fn(),
}));

vi.mock("@/lib/db/integrations", () => ({
  createIntegration: vi.fn(),
}));

import { GET } from "@/app/api/user/wallet/route";

const CREATOR_ID = "user-creator";
const OTHER_USER_ID = "user-other";
const ORG_ID = "org-1";

function buildWalletRow(userId: string): Record<string, unknown> {
  return {
    id: "wallet-1",
    userId,
    organizationId: ORG_ID,
    provider: "turnkey",
    email: "vault@example.com",
    walletAddress: "0x0000000000000000000000000000000000000001",
    paraWalletId: null,
    turnkeyWalletId: "tk-wallet-id",
    createdAt: new Date("2026-01-01"),
    isActive: true,
  };
}

function createGetRequest(): Request {
  return new Request("http://localhost/api/user/wallet", { method: "GET" });
}

describe("GET /api/user/wallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWalletSelectWhere.mockReset();
  });

  it("returns 401 when there is no session (non-session callers blocked)", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(createGetRequest());
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns isOwner: true for the wallet creator", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: CREATOR_ID, email: "creator@account.com" },
      session: { activeOrganizationId: ORG_ID },
    });
    mockGetActiveOrgId.mockReturnValue(ORG_ID);
    mockWalletSelectWhere.mockResolvedValueOnce([buildWalletRow(CREATOR_ID)]);

    const res = await GET(createGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isOwner).toBe(true);
    expect(data.wallets).toHaveLength(1);
    expect(data.wallets[0].isOwner).toBe(true);
  });

  it("returns isOwner: false for members who did not create the wallet", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: OTHER_USER_ID, email: "other@account.com" },
      session: { activeOrganizationId: ORG_ID },
    });
    mockGetActiveOrgId.mockReturnValue(ORG_ID);
    mockWalletSelectWhere.mockResolvedValueOnce([buildWalletRow(CREATOR_ID)]);

    const res = await GET(createGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isOwner).toBe(false);
    expect(data.wallets[0].isOwner).toBe(false);
  });
});
