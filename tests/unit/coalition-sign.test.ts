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

import { signCore } from "../../plugins/coalition/steps/sign-core";

const COALITION_ADDRESS = "0x000000000000000000000000000000000000aAaA";
const STAKE_TOKEN = "0x000000000000000000000000000000000000bbbb";
const STAKE_PER_PARTY = BigInt(1000);

const makeCoalition = (state: number) => ({
  termsHash: `0x${"ab".repeat(32)}`,
  participants: [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003",
  ],
  stakeToken: STAKE_TOKEN,
  stakePerParty: STAKE_PER_PARTY,
  deadline: BigInt(1800000000),
  signedCount: BigInt(0),
  breachedCount: BigInt(0),
  slashedCount: BigInt(0),
  state,
});

beforeEach(() => {
  readContractMock.mockReset();
  executeContractCallMock.mockReset();
});

describe("coalition sign", () => {
  it("idempotent: already signed returns wasAlreadySigned without sending a tx", async () => {
    readContractMock
      .mockResolvedValueOnce(makeCoalition(1)) // getCoalition -> state PROPOSED
      .mockResolvedValueOnce(true); // isSigned -> already signed

    const result = await signCore({
      network: "base-sepolia",
      coalitionId: "1",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.wasAlreadySigned).toBe(true);
    expect(executeContractCallMock).not.toHaveBeenCalled();
  });

  it("auto-approves when allowance is insufficient, then signs", async () => {
    readContractMock
      .mockResolvedValueOnce(makeCoalition(1)) // getCoalition
      .mockResolvedValueOnce(false) // isSigned -> not yet signed
      .mockResolvedValueOnce(BigInt(0)); // allowance -> insufficient

    executeContractCallMock
      .mockResolvedValueOnce({
        hash: "0xapproval",
        gasUsed: BigInt(50000),
        effectiveGasPrice: BigInt(1000000000),
        logs: [],
      })
      .mockResolvedValueOnce({
        hash: "0xsign",
        gasUsed: BigInt(80000),
        effectiveGasPrice: BigInt(1000000000),
        logs: [],
      });

    const result = await signCore({
      network: "base-sepolia",
      coalitionId: "1",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.wasAlreadySigned).toBe(false);
    expect(result.transactionHash).toBe("0xsign");
    expect(result.approvalTransactionHash).toBe("0xapproval");
    expect(executeContractCallMock).toHaveBeenCalledTimes(2);
  });

  it("skips approval when skipApproval=yes", async () => {
    readContractMock
      .mockResolvedValueOnce(makeCoalition(1)) // getCoalition
      .mockResolvedValueOnce(false); // isSigned -> not yet signed

    executeContractCallMock.mockResolvedValueOnce({
      hash: "0xsign",
      gasUsed: BigInt(80000),
      effectiveGasPrice: BigInt(1000000000),
      logs: [],
    });

    const result = await signCore({
      network: "base-sepolia",
      coalitionId: "1",
      skipApproval: "yes",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.transactionHash).toBe("0xsign");
    expect(result.approvalTransactionHash).toBeUndefined();
    expect(executeContractCallMock).toHaveBeenCalledTimes(1);
  });

  it("returns error when coalition is not in PROPOSED state", async () => {
    readContractMock.mockResolvedValueOnce(makeCoalition(2)); // state ACTIVE (2)

    const result = await signCore({
      network: "base-sepolia",
      coalitionId: "1",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/proposed/i);
  });

  it("surfaces approvalTransactionHash when sign tx fails after approve", async () => {
    readContractMock
      .mockResolvedValueOnce(makeCoalition(1)) // getCoalition
      .mockResolvedValueOnce(false) // isSigned -> not yet signed
      .mockResolvedValueOnce(BigInt(0)); // allowance -> insufficient

    executeContractCallMock
      .mockResolvedValueOnce({
        hash: "0xapproval",
        gasUsed: BigInt(50000),
        effectiveGasPrice: BigInt(1000000000),
        logs: [],
      })
      .mockRejectedValueOnce(new Error("nonce too low"));

    const result = await signCore({
      network: "base-sepolia",
      coalitionId: "1",
      _context: { organizationId: "org_1" },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    // The user paid for approval; the hash must come back so they don't
    // double-pay on retry and so the workflow audit trail captures it.
    expect(result.approvalTransactionHash).toBe("0xapproval");
    expect(result.error).toMatch(/nonce too low/i);
  });
});
