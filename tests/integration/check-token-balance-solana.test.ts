import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("ethers", () => ({
  ethers: {
    isAddress: vi.fn((a: string) => a.startsWith("0x") && a.length === 42),
    formatUnits: vi.fn((value: bigint, decimals: number) =>
      (Number(value) / 10 ** decimals).toString()
    ),
  },
}));

const {
  mockGetMint,
  mockGetAssociatedTokenAddress,
  mockGetAccount,
  MockTokenAccountNotFoundError,
} = vi.hoisted(() => {
  class TokenAccountNotFoundErrorStub extends Error {}
  return {
    mockGetMint: vi.fn(),
    mockGetAssociatedTokenAddress: vi.fn(),
    mockGetAccount: vi.fn(),
    MockTokenAccountNotFoundError: TokenAccountNotFoundErrorStub,
  };
});

vi.mock("@solana/spl-token", () => ({
  getMint: (...args: unknown[]) => mockGetMint(...args),
  getAssociatedTokenAddress: (...args: unknown[]) =>
    mockGetAssociatedTokenAddress(...args),
  getAccount: (...args: unknown[]) => mockGetAccount(...args),
  TokenAccountNotFoundError: MockTokenAccountNotFoundError,
}));

const { mockGetAddressUrl } = vi.hoisted(() => ({
  mockGetAddressUrl: vi.fn(),
}));

// Fake Solana adapter: the real one would resolve an on-chain RPC connection.
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    executeWithSolanaFailover: (fn: (connection: unknown) => unknown) => fn({}),
    getAddressUrl: (...args: unknown[]) => mockGetAddressUrl(...args),
  }),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn((network: string) => {
    if (network === "solana-devnet") {
      return 103;
    }
    throw new Error(`Unsupported network: ${network}`);
  }),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(),
  isSolanaChain: (chainId: number) => chainId === 101 || chainId === 103,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ userId: "user_1" }]) }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  supportedTokens: {
    chainId: "chainId",
    id: "id",
    tokenAddress: "tokenAddress",
  },
  workflowExecutions: { id: "id", userId: "userId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", NETWORK_RPC: "network_rpc" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (error: { message?: string }) =>
    error?.message ?? String(error),
}));

import { checkTokenBalanceStep } from "@/plugins/web3/steps/check-token-balance";

const WALLET = "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const context = () => ({
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Get SPL Balance",
  nodeType: "check-token-balance" as const,
});

const input = () => ({
  network: "solana-devnet",
  address: WALLET,
  tokenConfig: {
    mode: "custom",
    customToken: { address: MINT, symbol: "TEST" },
  },
  _context: context(),
});

describe("checkTokenBalanceStep - Solana", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAssociatedTokenAddress.mockResolvedValue(ATA);
    mockGetAddressUrl.mockResolvedValue(
      "https://solscan.io/account/x?cluster=devnet"
    );
  });

  it("fetches an SPL token balance for a funded associated token account", async () => {
    mockGetMint.mockResolvedValue({ decimals: 6 });
    mockGetAccount.mockResolvedValue({ amount: BigInt(5_000_000) });

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balance.balance).toBe("5");
      expect(result.balance.balanceRaw).toBe("5000000");
      expect(result.balance.decimals).toBe(6);
      expect(result.balance.symbol).toBe("TEST");
      expect(result.balance.tokenAddress).toBe(MINT);
      expect(result.address).toBe(WALLET);
    }
  });

  it("returns a zero balance when the wallet has no associated token account", async () => {
    mockGetMint.mockResolvedValue({ decimals: 9 });
    mockGetAccount.mockRejectedValue(new MockTokenAccountNotFoundError());

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balance.balance).toBe("0");
      expect(result.balance.balanceRaw).toBe("0");
    }
  });

  it("propagates a real RPC error instead of treating it as a zero balance", async () => {
    mockGetMint.mockResolvedValue({ decimals: 9 });
    mockGetAccount.mockRejectedValue(new Error("RPC timeout"));

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(false);
  });

  it("rejects an invalid Solana wallet address before touching the chain", async () => {
    const result = await checkTokenBalanceStep({
      ...input(),
      address: "not a valid base58 address",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid wallet address");
    }
    expect(mockGetMint).not.toHaveBeenCalled();
    expect(mockGetAccount).not.toHaveBeenCalled();
  });
});
