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

import { dissolveCore } from "../../plugins/coalition/steps/dissolve-core";

const ACTIVE_ERROR_RE = /active/i;

beforeEach(() => {
  readContractMock.mockReset();
  executeContractCallMock.mockReset();
});

const PARTICIPANT_ERROR_RE = /participant/i;

describe("coalition dissolve", () => {
  it("happy path: ACTIVE -> dissolves", async () => {
    readContractMock.mockResolvedValueOnce({
      state: 2,
      participants: [
        "0xWallet",
        "0x0000000000000000000000000000000000000002",
      ],
    });

    executeContractCallMock.mockResolvedValueOnce({
      hash: "0xdissolve",
      gasUsed: BigInt(60_000),
      effectiveGasPrice: BigInt(1_000_000_000),
      logs: [],
    });

    const result = await dissolveCore({
      network: "base-sepolia",
      coalitionId: "1",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.transactionHash).toBe("0xdissolve");
  });

  it("fast-fail when not ACTIVE", async () => {
    readContractMock.mockResolvedValueOnce({ state: 1, participants: [] });

    const result = await dissolveCore({
      network: "base-sepolia",
      coalitionId: "1",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(ACTIVE_ERROR_RE);
    expect(executeContractCallMock).not.toHaveBeenCalled();
  });

  it("fast-fail when caller is not a participant", async () => {
    readContractMock.mockResolvedValueOnce({
      state: 2,
      participants: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ],
    });

    const result = await dissolveCore({
      network: "base-sepolia",
      coalitionId: "1",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(PARTICIPANT_ERROR_RE);
    expect(executeContractCallMock).not.toHaveBeenCalled();
  });
});
