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

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(async () => ({
    resolveActiveRpcUrl: async () => "http://rpc",
    executeWithFailover: async (
      fn: (provider: {
        getTransactionReceipt: (h: string) => Promise<unknown>;
      }) => Promise<unknown>,
      _label?: string
    ) =>
      fn({
        getTransactionReceipt: async (_h: string) => null,
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

vi.mock("@/lib/web3/gas-defaults", () => ({
  parsePriorityFeeGwei: () => undefined,
  resolveGasLimitOverrides: () => ({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

vi.mock("@/lib/utils/id", () => ({ generateId: () => "gen_1" }));

import { breachCore } from "../../plugins/coalition/steps/breach-core";

const ACTIVE_RE = /active/i;
const PARTICIPANT_RE = /participant/i;
const ALREADY_BREACHED_RE = /already.*breached/i;

const PARTY_A = "0x0000000000000000000000000000000000000001";
const PARTY_B = "0x0000000000000000000000000000000000000002";
const EVIDENCE_HASH =
  "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

beforeEach(() => {
  readContractMock.mockReset();
  executeContractCallMock.mockReset();
});

describe("coalition breach", () => {
  it("happy path: ACTIVE + participant + !breached -> records breach", async () => {
    readContractMock.mockResolvedValueOnce({
      state: BigInt(2),
      participants: [PARTY_A, PARTY_B],
      stakeToken: "0x0000000000000000000000000000000000000010",
      stakePerParty: BigInt(1000),
    });
    readContractMock.mockResolvedValueOnce(false);

    executeContractCallMock.mockResolvedValueOnce({
      hash: "0xbreach",
      gasUsed: BigInt(30_000),
      effectiveGasPrice: BigInt(1_000_000_000),
      logs: [],
    });

    const result = await breachCore({
      network: "base-sepolia",
      coalitionId: "1",
      breachingParty: PARTY_A,
      evidenceHash: EVIDENCE_HASH,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.transactionHash).toBe("0xbreach");
    expect(executeContractCallMock).toHaveBeenCalledTimes(1);
  });

  it("fast-fail when not ACTIVE", async () => {
    readContractMock.mockResolvedValueOnce({
      state: BigInt(1),
      participants: [PARTY_A, PARTY_B],
      stakeToken: "0x0000000000000000000000000000000000000010",
      stakePerParty: BigInt(1000),
    });

    const result = await breachCore({
      network: "base-sepolia",
      coalitionId: "1",
      breachingParty: PARTY_A,
      evidenceHash: EVIDENCE_HASH,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(ACTIVE_RE);
    expect(executeContractCallMock).not.toHaveBeenCalled();
  });

  it("fast-fail on non-participant", async () => {
    readContractMock.mockResolvedValueOnce({
      state: BigInt(2),
      participants: [PARTY_A, PARTY_B],
      stakeToken: "0x0000000000000000000000000000000000000010",
      stakePerParty: BigInt(1000),
    });

    const result = await breachCore({
      network: "base-sepolia",
      coalitionId: "1",
      breachingParty: "0x0000000000000000000000000000000000000099",
      evidenceHash: EVIDENCE_HASH,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(PARTICIPANT_RE);
    expect(executeContractCallMock).not.toHaveBeenCalled();
  });

  it("fast-fail when already breached", async () => {
    readContractMock.mockResolvedValueOnce({
      state: BigInt(2),
      participants: [PARTY_A, PARTY_B],
      stakeToken: "0x0000000000000000000000000000000000000010",
      stakePerParty: BigInt(1000),
    });
    readContractMock.mockResolvedValueOnce(true);

    const result = await breachCore({
      network: "base-sepolia",
      coalitionId: "1",
      breachingParty: PARTY_A,
      evidenceHash: EVIDENCE_HASH,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(ALREADY_BREACHED_RE);
    expect(executeContractCallMock).not.toHaveBeenCalled();
  });
});
