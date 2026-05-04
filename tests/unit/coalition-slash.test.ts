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

vi.mock("@/lib/web3/sponsorship-feature-flag", () => ({
  isGasSponsorshipEnabled: () => false,
}));

vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: vi.fn(async () => null),
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  parsePriorityFeeGwei: () => undefined,
  resolveGasLimitOverrides: () => ({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

vi.mock("@/lib/utils/id", () => ({ generateId: () => "gen_1" }));

import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { slashCore } from "../../plugins/coalition/steps/slash-core";

const PARTY_ADDR = "0x0000000000000000000000000000000000000001";

const COALITION_STATE_ACTIVE = {
  state: 2,
  participants: [
    PARTY_ADDR,
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003",
  ],
  termsHash: `0x${"ab".repeat(32)}`,
  stakeToken: "0x000000000000000000000000000000000000bbbb",
  stakePerParty: BigInt(1000),
  deadline: BigInt(1800000000),
  signedCount: 3,
  breachedCount: 1,
  slashedCount: 0,
};

beforeEach(() => {
  readContractMock.mockReset();
  executeContractCallMock.mockReset();
  mockReceiptForRefetch = null;
});

describe("coalition slash", () => {
  it("happy path: parses amountRedistributed from Slashed event", async () => {
    const { ethers } = await import("ethers");
    const { COALITION_ABI } = await import(
      "../../plugins/coalition/contracts/coalition-abi"
    );
    const iface = new ethers.Interface(
      // biome-ignore lint/suspicious/noExplicitAny: ABI constant satisfies InterfaceAbi at runtime
      COALITION_ABI as any
    );
    const log = iface.encodeEventLog("Slashed", [
      BigInt(1),
      PARTY_ADDR,
      BigInt(1000),
    ]);

    readContractMock
      .mockResolvedValueOnce(COALITION_STATE_ACTIVE)
      .mockResolvedValueOnce(true);

    executeContractCallMock.mockResolvedValueOnce({
      hash: "0xslash",
      gasUsed: BigInt(80000),
      effectiveGasPrice: BigInt(1000000000),
      logs: [],
    });

    mockReceiptForRefetch = { logs: [{ topics: log.topics, data: log.data }] };

    const result = await slashCore({
      network: "base-sepolia",
      coalitionId: "1",
      party: PARTY_ADDR,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.transactionHash).toBe("0xslash");
    expect(result.amountRedistributed).toBe("1000");
    expect(result.party).toBe(PARTY_ADDR);
  });

  it("fast-fail when party not breached", async () => {
    readContractMock
      .mockResolvedValueOnce(COALITION_STATE_ACTIVE)
      .mockResolvedValueOnce(false);

    const result = await slashCore({
      network: "base-sepolia",
      coalitionId: "1",
      party: PARTY_ADDR,
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/not.*breached/i);
  });

  it("usePrivateMempool=yes plumbs through to getRpcProvider", async () => {
    const { ethers } = await import("ethers");
    const { COALITION_ABI } = await import(
      "../../plugins/coalition/contracts/coalition-abi"
    );
    const iface = new ethers.Interface(
      // biome-ignore lint/suspicious/noExplicitAny: ABI constant satisfies InterfaceAbi at runtime
      COALITION_ABI as any
    );
    const log = iface.encodeEventLog("Slashed", [
      BigInt(1),
      PARTY_ADDR,
      BigInt(1000),
    ]);

    readContractMock
      .mockResolvedValueOnce(COALITION_STATE_ACTIVE)
      .mockResolvedValueOnce(true);

    executeContractCallMock.mockResolvedValueOnce({
      hash: "0xslash",
      gasUsed: BigInt(80000),
      effectiveGasPrice: BigInt(1000000000),
      logs: [],
    });

    mockReceiptForRefetch = { logs: [{ topics: log.topics, data: log.data }] };

    const result = await slashCore({
      network: "base-sepolia",
      coalitionId: "1",
      party: PARTY_ADDR,
      usePrivateMempool: "yes",
      strict: "no",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    expect(getRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ usePrivateMempool: true, strict: false })
    );
  });
});
