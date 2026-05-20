import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSafeAppUrl,
  getSafeChainPrefix,
} from "@/components/safe/chain-prefixes";

vi.mock("server-only", () => ({}));

const selectLimitMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: selectLimitMock,
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  safeWallets: {
    id: "id",
    safeAddress: "safeAddress",
    status: "status",
    isSigningActive: "isSigningActive",
    organizationId: "organizationId",
    chainId: "chainId",
  },
  safeRoles: {
    rolesModifierAddress: "rolesModifierAddress",
    roleKey: "roleKey",
    delegateAddress: "delegateAddress",
    status: "status",
    safeWalletId: "safeWalletId",
    roleType: "roleType",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
}));

const getOrganizationWalletAddressMock = vi.fn();
const getOrganizationWalletMock = vi.fn();

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: getOrganizationWalletMock,
  getOrganizationWalletAddress: getOrganizationWalletAddressMock,
}));

vi.mock("@/lib/address-utils", () => ({
  normalizeAddressForStorage: (addr: string) => addr.toLowerCase(),
}));

// The signer-resolver pulls these in for the chain-state probe + reconcile
// fallback. Tests want to stay DB-only so we stub them to "no modules on
// chain" and a no-op reconcile -- the routing behaviour we're asserting
// here is purely the DB-based decision.
vi.mock("@/lib/rpc/rpc-config", () => ({
  getRpcUrlByChainId: () => "http://stub",
}));
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProviderFromUrls: async () => ({ getProvider: () => ({}) }),
}));
vi.mock("@/lib/safe/zodiac-roles", () => ({
  readEnabledSafeModules: async () => [],
  findRolesModifierForSafe: async () => null,
}));
vi.mock("@/lib/safe/zodiac-contracts", () => ({
  orgAutomationRoleKey: () => "0xrole",
}));
vi.mock("@/lib/safe/roles-orchestrator", () => ({
  reconcileSafeRoleFromChain: async () => ({
    success: true,
    installed: false,
    reason: "no-roles-modifier",
  }),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: () => {
    // swallow logs in tests
  },
}));

// Import after mocks
const { resolveSignerMode } = await import("@/lib/safe/signer-resolver");

const ORG_ID = "org_test";
const CHAIN_ID = 8453;
const OWNER = "0xAAAA000000000000000000000000000000000000";
const SAFE = "0xBBBB000000000000000000000000000000000000";

describe("resolveSignerMode", () => {
  beforeEach(() => {
    selectLimitMock.mockReset();
    getOrganizationWalletAddressMock.mockReset();
    getOrganizationWalletAddressMock.mockResolvedValue(OWNER);
  });

  it("returns eoa mode when no Safe exists for (org, chain)", async () => {
    selectLimitMock.mockResolvedValue([]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("eoa");
    if (mode.kind === "eoa") {
      expect(mode.ownerAddress).toBe(OWNER.toLowerCase());
    }
  });

  it("returns eoa mode when Safe exists but signing toggle is off", async () => {
    selectLimitMock.mockResolvedValue([
      {
        id: "safe-1",
        safeAddress: SAFE,
        status: "deployed",
        isSigningActive: false,
      },
    ]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("eoa");
  });

  it("returns eoa mode when Safe is still pending even if toggle is on", async () => {
    selectLimitMock.mockResolvedValue([
      {
        id: "safe-1",
        safeAddress: SAFE,
        status: "pending",
        isSigningActive: true,
      },
    ]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("eoa");
  });

  it("returns safe mode when Safe is deployed and toggle is on", async () => {
    // First .limit() call (safeWallets) -> the deployed Safe.
    // Second .limit() call (safeRoles) -> empty: no DB role row.
    // Chain probe is mocked to return no modules, so signer-resolver
    // falls through to plain `safe` mode.
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("safe");
    if (mode.kind === "safe") {
      expect(mode.ownerAddress).toBe(OWNER.toLowerCase());
      expect(mode.safeAddress).toBe(SAFE);
      expect(mode.safeWalletId).toBe("safe-1");
    }
  });

  it("returns safe-role mode when DB has the role row", async () => {
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          rolesModifierAddress: "0xMOD",
          roleKey: "0xkey",
          delegateAddress: "0xdelegate",
          status: "active",
        },
      ]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("safe-role");
    if (mode.kind === "safe-role") {
      expect(mode.rolesModifierAddress).toBe("0xMOD");
      expect(mode.roleKey).toBe("0xkey");
    }
  });
});

describe("chain-prefixes", () => {
  it("returns app.safe.global URL for supported mainnets", () => {
    expect(getSafeAppUrl(1, SAFE)).toBe(
      `https://app.safe.global/home?safe=eth:${SAFE}`
    );
    expect(getSafeAppUrl(8453, SAFE)).toBe(
      `https://app.safe.global/home?safe=base:${SAFE}`
    );
  });

  it("returns app.safe.global URL for supported testnets", () => {
    expect(getSafeAppUrl(11_155_111, SAFE)).toBe(
      `https://app.safe.global/home?safe=sep:${SAFE}`
    );
    expect(getSafeAppUrl(84_532, SAFE)).toBe(
      `https://app.safe.global/home?safe=basesep:${SAFE}`
    );
  });

  it("returns null for unknown chains (UI should hide the link)", () => {
    expect(getSafeChainPrefix(9999)).toBeNull();
    expect(getSafeAppUrl(9999, SAFE)).toBeNull();
  });
});
