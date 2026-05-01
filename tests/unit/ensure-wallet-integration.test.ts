import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockOrganizationHasWallet = vi.fn();
const mockGetOrganizationWallet = vi.fn();

vi.mock("@/lib/para/wallet-helpers", () => ({
  organizationHasWallet: (...args: unknown[]) =>
    mockOrganizationHasWallet(...args),
  getOrganizationWallet: (...args: unknown[]) =>
    mockGetOrganizationWallet(...args),
}));

const mockSelectLimit = vi.fn();
const mockInsertReturning = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: (...args: unknown[]) => mockSelectLimit(...args),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  integrations: { id: "id", organizationId: "organization_id", type: "type" },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock("@/plugins/registry", () => ({
  findActionById: vi.fn(),
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/address-utils", () => ({
  truncateAddress: (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`,
}));

const ORIGINAL_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY;
process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);

const { ensureWalletIntegration, buildWalletIntegrationPayload } = await import(
  "@/lib/db/integrations"
);

const USER_ID = "user-1";
const ORG_ID = "org-1";
const WALLET_ADDRESS = "0xA3CD0000000000000000000000000000000007Eb3";

describe("ensureWalletIntegration", () => {
  beforeEach(() => {
    mockOrganizationHasWallet.mockReset();
    mockGetOrganizationWallet.mockReset();
    mockSelectLimit.mockReset();
    mockInsertReturning.mockReset();
  });

  it("no-ops when the org has no wallet", async () => {
    mockOrganizationHasWallet.mockResolvedValue(false);

    await ensureWalletIntegration(USER_ID, ORG_ID);

    expect(mockOrganizationHasWallet).toHaveBeenCalledWith(ORG_ID);
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it("no-ops when a web3 row already exists", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([{ id: "existing-row" }]);

    await ensureWalletIntegration(USER_ID, ORG_ID);

    expect(mockGetOrganizationWallet).not.toHaveBeenCalled();
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it("inserts when no row exists and returns cleanly", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([]);
    mockGetOrganizationWallet.mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
    });
    mockInsertReturning.mockResolvedValue([
      {
        id: "new-row",
        userId: USER_ID,
        organizationId: ORG_ID,
        name: "0xA3CD...7Eb3",
        type: "web3",
        config: "encrypted",
        isManaged: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await expect(
      ensureWalletIntegration(USER_ID, ORG_ID)
    ).resolves.toBeUndefined();
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
  });

  it("swallows 23505 unique_violation when a concurrent caller wins the race", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([]);
    mockGetOrganizationWallet.mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
    });
    const uniqueViolation = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    mockInsertReturning.mockRejectedValueOnce(uniqueViolation);

    await expect(
      ensureWalletIntegration(USER_ID, ORG_ID)
    ).resolves.toBeUndefined();
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
  });

  it("re-throws non-23505 errors from createIntegration", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([]);
    mockGetOrganizationWallet.mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
    });
    const otherError = Object.assign(new Error("connection refused"), {
      code: "08006",
    });
    mockInsertReturning.mockRejectedValueOnce(otherError);

    await expect(ensureWalletIntegration(USER_ID, ORG_ID)).rejects.toThrow(
      "connection refused"
    );
  });
});

describe("buildWalletIntegrationPayload", () => {
  it("produces the canonical web3 integration shape", () => {
    const payload = buildWalletIntegrationPayload(
      USER_ID,
      ORG_ID,
      WALLET_ADDRESS
    );

    expect(payload).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      name: "0xA3CD...7Eb3",
      type: "web3",
      config: {},
    });
  });
});

if (ORIGINAL_ENCRYPTION_KEY === undefined) {
  process.env.INTEGRATION_ENCRYPTION_KEY = undefined;
} else {
  process.env.INTEGRATION_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}
