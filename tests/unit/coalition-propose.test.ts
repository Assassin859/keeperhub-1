import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
    EXTERNAL_SERVICE: "external_service",
    TRANSACTION: "transaction",
  },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
    query: {
      workflowExecutions: {
        findFirst: vi.fn(async () => undefined),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
  explorerConfigs: { id: "id", chainId: "chainId" },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (n: string) => {
    if (n === "base-sepolia") {
      return 84_532;
    }
    if (n === "base") {
      return 8453;
    }
    throw new Error(`Unsupported network: ${n}`);
  },
}));

let mockReceiptForRefetch: { logs: { topics: string[]; data: string }[] } | null = null;

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(async () => ({
    resolveActiveRpcUrl: async () => "http://rpc",
    executeWithFailover: async (
      fn: (provider: { getTransactionReceipt: (h: string) => Promise<unknown> }) => Promise<unknown>,
      _label?: string,
    ) => fn({
      getTransactionReceipt: async (_h: string) => mockReceiptForRefetch,
    }),
  })),
}));

const readContractMock = vi.fn();
const executeContractCallMock = vi.fn();
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    readContract: readContractMock,
    executeContractCall: executeContractCallMock,
    getTransactionUrl: async (h: string) => `https://explorer/tx/${h}`,
    getAddressUrl: async (a: string) => `https://explorer/addr/${a}`,
  }),
}));

vi.mock("@/lib/web3/decode-revert-error", () => ({
  formatContractError: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

vi.mock("../../plugins/coalition/contracts/addresses", () => ({
  COALITION_ADDRESSES: { 84532: "0x000000000000000000000000000000000000aAaA" },
  SUPPORTED_CHAIN_IDS: [84_532, 8453],
}));

vi.mock("@/lib/para/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi.fn(async () => "0xWallet"),
  initializeWalletSigner: vi.fn(async () => ({ signer: true })),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn(async () => ({
    success: true,
    organizationId: "org_1",
    userId: "user_1",
  })),
}));

vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: async (
    _ctx: unknown,
    _addr: string,
    fn: (s: unknown) => Promise<unknown>
  ) => fn({}),
}));

type SponsoredResult = { transactionHash: string; gasUsed: string } | null;
const isGasSponsorshipEnabledMock = vi.fn<[], boolean>(() => false);
const executeSponsoredContractTransactionMock = vi.fn<[unknown], Promise<SponsoredResult>>(
  async () => null
);
vi.mock("@/lib/web3/sponsorship-feature-flag", () => ({
  isGasSponsorshipEnabled: () => isGasSponsorshipEnabledMock(),
}));
vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: (args: unknown) =>
    executeSponsoredContractTransactionMock(args),
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  parsePriorityFeeGwei: () => undefined,
  resolveGasLimitOverrides: () => ({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

vi.mock("@/lib/utils/id", () => ({ generateId: () => "gen_1" }));

import { proposeCore } from "../../plugins/coalition/steps/propose-core";

const VALID_PARTICIPANTS = JSON.stringify([
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
]);
const VALID_TERMS_HASH = `0x${"ab".repeat(32)}`;
const VALID_DEADLINE = "1800000000";
const VALID_STAKE_TOKEN = "0x000000000000000000000000000000000000bbbb";
const VALID_STAKE_PER_PARTY = "1000000000000000000";

beforeEach(() => {
  readContractMock.mockReset();
  executeContractCallMock.mockReset();
  mockReceiptForRefetch = null;
  isGasSponsorshipEnabledMock.mockReset();
  isGasSponsorshipEnabledMock.mockReturnValue(false);
  executeSponsoredContractTransactionMock.mockReset();
  executeSponsoredContractTransactionMock.mockResolvedValue(null);
});

describe("coalition propose", () => {
  it("returns coalitionId on happy path", async () => {
    const { ethers } = await import("ethers");
    const { COALITION_ABI } = await import(
      "../../plugins/coalition/contracts/coalition-abi"
    );
    const iface = new ethers.Interface(
      // biome-ignore lint/suspicious/noExplicitAny: ABI constant satisfies InterfaceAbi at runtime
      COALITION_ABI as any
    );
    const log = iface.encodeEventLog("Proposed", [
      BigInt(42),
      `0x${"ab".repeat(32)}`,
      [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ],
      "0x000000000000000000000000000000000000bbbb",
      BigInt(1000),
      BigInt(1800000000),
    ]);

    executeContractCallMock.mockResolvedValueOnce({
      hash: "0xtxhash",
      gasUsed: BigInt(100000),
      effectiveGasPrice: BigInt(1000000000),
    });

    mockReceiptForRefetch = { logs: [{ topics: log.topics, data: log.data }] };

    const result = await proposeCore({
      network: "base-sepolia",
      participants: VALID_PARTICIPANTS,
      termsHash: VALID_TERMS_HASH,
      deadlineUnix: VALID_DEADLINE,
      stakeToken: VALID_STAKE_TOKEN,
      stakePerParty: VALID_STAKE_PER_PARTY,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.coalitionId).toBe("42");
    expect(result.transactionHash).toBe("0xtxhash");
  });

  it("rejects fewer than 2 participants", async () => {
    const result = await proposeCore({
      network: "base-sepolia",
      participants: JSON.stringify(["0x0000000000000000000000000000000000000001"]),
      termsHash: VALID_TERMS_HASH,
      deadlineUnix: VALID_DEADLINE,
      stakeToken: VALID_STAKE_TOKEN,
      stakePerParty: VALID_STAKE_PER_PARTY,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/participant/i);
  });

  it("rejects deadline in the past", async () => {
    const result = await proposeCore({
      network: "base-sepolia",
      participants: VALID_PARTICIPANTS,
      termsHash: VALID_TERMS_HASH,
      deadlineUnix: "1",
      stakeToken: VALID_STAKE_TOKEN,
      stakePerParty: VALID_STAKE_PER_PARTY,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/deadline/i);
  });

  it("rejects malformed termsHash", async () => {
    const result = await proposeCore({
      network: "base-sepolia",
      participants: VALID_PARTICIPANTS,
      termsHash: "0xnothash",
      deadlineUnix: VALID_DEADLINE,
      stakeToken: VALID_STAKE_TOKEN,
      stakePerParty: VALID_STAKE_PER_PARTY,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/termsHash/i);
  });

  it("rejects invalid stake address or zero stake", async () => {
    const result = await proposeCore({
      network: "base-sepolia",
      participants: VALID_PARTICIPANTS,
      termsHash: VALID_TERMS_HASH,
      deadlineUnix: VALID_DEADLINE,
      stakeToken: VALID_STAKE_TOKEN,
      stakePerParty: "0",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
  });

  it("sponsored path refetches receipt and returns coalitionId", async () => {
    const { ethers } = await import("ethers");
    const { COALITION_ABI } = await import(
      "../../plugins/coalition/contracts/coalition-abi"
    );
    const iface = new ethers.Interface(
      // biome-ignore lint/suspicious/noExplicitAny: ABI constant satisfies InterfaceAbi at runtime
      COALITION_ABI as any
    );
    const log = iface.encodeEventLog("Proposed", [
      BigInt(7),
      `0x${"ab".repeat(32)}`,
      [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ],
      "0x000000000000000000000000000000000000bbbb",
      BigInt(1000),
      BigInt(1800000000),
    ]);

    isGasSponsorshipEnabledMock.mockReturnValue(true);
    executeSponsoredContractTransactionMock.mockResolvedValueOnce({
      transactionHash: "0xsponsored",
      gasUsed: "50000",
    });
    mockReceiptForRefetch = { logs: [{ topics: log.topics, data: log.data }] };

    const result = await proposeCore({
      network: "base-sepolia",
      participants: VALID_PARTICIPANTS,
      termsHash: VALID_TERMS_HASH,
      deadlineUnix: VALID_DEADLINE,
      stakeToken: VALID_STAKE_TOKEN,
      stakePerParty: VALID_STAKE_PER_PARTY,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.coalitionId).toBe("7");
    expect(result.transactionHash).toBe("0xsponsored");
    expect(executeContractCallMock).not.toHaveBeenCalled();
  });

  it("sponsored path fails loudly when receipt has no Proposed event", async () => {
    isGasSponsorshipEnabledMock.mockReturnValue(true);
    executeSponsoredContractTransactionMock.mockResolvedValueOnce({
      transactionHash: "0xsponsored",
      gasUsed: "50000",
    });
    // Receipt comes back with no logs - simulates a confirmed tx that
    // somehow did not emit Proposed (shouldn't happen, but we surface it
    // rather than returning a corrupt empty coalitionId).
    mockReceiptForRefetch = { logs: [] };

    const result = await proposeCore({
      network: "base-sepolia",
      participants: VALID_PARTICIPANTS,
      termsHash: VALID_TERMS_HASH,
      deadlineUnix: VALID_DEADLINE,
      stakeToken: VALID_STAKE_TOKEN,
      stakePerParty: VALID_STAKE_PER_PARTY,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/Proposed event/i);
  });
});
