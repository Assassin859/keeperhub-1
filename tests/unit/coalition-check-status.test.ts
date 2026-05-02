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
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
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
  })),
}));

const readContractMock = vi.fn();
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({ readContract: readContractMock }),
}));

vi.mock("@/lib/web3/decode-revert-error", () => ({
  formatContractError: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

vi.mock("../../plugins/coalition/contracts/addresses", () => ({
  COALITION_ADDRESSES: { 84532: "0x000000000000000000000000000000000000aAaA" },
  SUPPORTED_CHAIN_IDS: [84_532, 8453],
}));

import { checkStatusStep } from "../../plugins/coalition/steps/check-status";

const DOES_NOT_EXIST_RE = /does not exist/i;

beforeEach(() => {
  readContractMock.mockReset();
});

describe("coalition check-status", () => {
  it("returns parsed status for an ACTIVE coalition with all signed", async () => {
    readContractMock.mockResolvedValue({
      termsHash: `0x${"ab".repeat(32)}`,
      participants: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
      ],
      stakeToken: "0x000000000000000000000000000000000000bbbb",
      stakePerParty: "1000000000000000000",
      deadline: "1800000000",
      signedCount: 3,
      breachedCount: 0,
      slashedCount: 0,
      state: 2,
    });

    const result = await checkStatusStep({
      network: "base-sepolia",
      coalitionId: "1",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.state).toBe("ACTIVE");
    expect(result.signedCount).toBe(3);
    expect(result.breachedCount).toBe(0);
    expect(result.slashedCount).toBe(0);
    expect(result.totalParticipants).toBe(3);
    expect(result.ready).toBe(false);
  });

  it("flags ready=true when state is PROPOSED and all signed", async () => {
    readContractMock.mockResolvedValue({
      termsHash: `0x${"00".repeat(32)}`,
      participants: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ],
      stakeToken: "0x000000000000000000000000000000000000bbbb",
      stakePerParty: "0",
      deadline: "1800000000",
      signedCount: 2,
      breachedCount: 0,
      slashedCount: 0,
      state: 1,
    });

    const result = await checkStatusStep({
      network: "base-sepolia",
      coalitionId: "5",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.state).toBe("PROPOSED");
    expect(result.ready).toBe(true);
  });

  it("returns error for missing coalition (state==NONE)", async () => {
    readContractMock.mockResolvedValue({
      termsHash: `0x${"00".repeat(32)}`,
      participants: [],
      stakeToken: "0x0000000000000000000000000000000000000000",
      stakePerParty: "0",
      deadline: "0",
      signedCount: 0,
      breachedCount: 0,
      slashedCount: 0,
      state: 0,
    });

    const result = await checkStatusStep({
      network: "base-sepolia",
      coalitionId: "999",
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(DOES_NOT_EXIST_RE);
  });

  it("returns error on invalid coalitionId", async () => {
    const result = await checkStatusStep({
      network: "base-sepolia",
      coalitionId: "not-a-number",
    });
    expect(result.success).toBe(false);
  });

  it("returns error on unsupported chain", async () => {
    const result = await checkStatusStep({
      network: "polygon",
      coalitionId: "1",
    });
    expect(result.success).toBe(false);
  });
});
