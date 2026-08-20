import { PublicKey } from "@solana/web3.js";
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

// Real, well-known program IDs - needed so parseSolanaMintAccount's
// programId.equals(TOKEN_PROGRAM_ID) checks behave like the real library.
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

const { mockUnpackMint, mockUnpackAccount, mockGetAssociatedTokenAddressSync } =
  vi.hoisted(() => ({
    mockUnpackMint: vi.fn(),
    mockUnpackAccount: vi.fn(),
    mockGetAssociatedTokenAddressSync: vi.fn(),
  }));

vi.mock("@solana/spl-token", async () => {
  const actual =
    await vi.importActual<typeof import("@solana/spl-token")>(
      "@solana/spl-token"
    );
  return {
    TOKEN_PROGRAM_ID: actual.TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID: actual.TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID: actual.ASSOCIATED_TOKEN_PROGRAM_ID,
    unpackMint: (...args: unknown[]) => mockUnpackMint(...args),
    unpackAccount: (...args: unknown[]) => mockUnpackAccount(...args),
    getAssociatedTokenAddressSync: (...args: unknown[]) =>
      mockGetAssociatedTokenAddressSync(...args),
  };
});

const {
  mockConnectionGetAccountInfo,
  mockGetAddressUrl,
  mockGetSolanaProvider,
} = vi.hoisted(() => ({
  mockConnectionGetAccountInfo: vi.fn(),
  mockGetAddressUrl: vi.fn(),
  mockGetSolanaProvider: vi.fn(),
}));

// check-token-balance.ts's (unexercised here) EVM branch still imports the
// real registry, which pulls in EvmChainAdapter -> nonce-manager -> schema's
// drizzle sql() helper. Stub it so that module-load chain never runs.
vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn(),
}));

// Fake adapter: constructed directly (not via the shared registry) so the
// step can thread userId into getSolanaProvider - see checkSolanaTokenBalance
// in check-token-balance.ts. The real adapter would resolve an on-chain RPC
// connection; here executeWithSolanaFailover both exercises the
// userId-carrying provider factory (for assertions below) and hands back a
// fake connection.
vi.mock("@/lib/web3/chain-adapter/solana", () => ({
  SolanaChainAdapter: class MockSolanaChainAdapter {
    private readonly providerFactory: () => unknown;
    constructor(_chainId: number, providerFactory: () => unknown) {
      this.providerFactory = providerFactory;
    }
    async executeWithSolanaFailover(fn: (connection: unknown) => unknown) {
      await this.providerFactory();
      return fn({
        getAccountInfo: (...args: unknown[]) =>
          mockConnectionGetAccountInfo(...args),
      });
    }
    getAddressUrl(...args: unknown[]) {
      return mockGetAddressUrl(...args);
    }
  },
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
  getSolanaProvider: (...args: unknown[]) => mockGetSolanaProvider(...args),
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
const OFF_CURVE_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "4gZfWA6UftMD8W3XqPB8p7cN8G2p9J4ELuTFCe4gTaeM";

function fakeAccountInfo(owner: PublicKey) {
  return { owner, data: Buffer.alloc(0), lamports: 0, executable: false };
}

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
    mockGetSolanaProvider.mockResolvedValue({
      executeWithFailover: vi.fn(),
    });
    mockGetAssociatedTokenAddressSync.mockReturnValue(new PublicKey(ATA));
    mockGetAddressUrl.mockResolvedValue(
      "https://solscan.io/account/x?cluster=devnet"
    );
  });

  it("fetches a legacy SPL token balance for a funded associated token account", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // mint account
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)); // ATA account
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(5_000_000) });

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balance.balance).toBe("5");
      expect(result.balance.balanceRaw).toBe("5000000");
      expect(result.balance.decimals).toBe(6);
      expect(result.balance.symbol).toBe("TEST");
      expect(result.balance.tokenAddress).toBe(MINT);
    }
    // getAssociatedTokenAddressSync's allowOwnerOffCurve argument (3rd) must
    // be true - checking a PDA-owned wallet's balance is legitimate.
    expect(mockGetAssociatedTokenAddressSync).toHaveBeenCalledWith(
      expect.any(PublicKey),
      expect.any(PublicKey),
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  it("fetches a Token-2022 mint's balance instead of failing with an owner-mismatch error", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_2022_PROGRAM_ID))
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_2022_PROGRAM_ID));
    mockUnpackMint.mockReturnValue({ decimals: 9 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(1_000_000_000) });

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balance.balance).toBe("1");
    }
    expect(mockUnpackMint).toHaveBeenCalledWith(
      expect.any(PublicKey),
      expect.anything(),
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("returns a zero balance when the wallet has no associated token account", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID)) // mint account
      .mockResolvedValueOnce(null); // no ATA yet
    mockUnpackMint.mockReturnValue({ decimals: 9 });

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.balance.balance).toBe("0");
      expect(result.balance.balanceRaw).toBe("0");
    }
    expect(mockUnpackAccount).not.toHaveBeenCalled();
  });

  it("fetches the balance of an off-curve (PDA-owned) wallet address", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID));
    mockUnpackMint.mockReturnValue({ decimals: 6 });
    mockUnpackAccount.mockReturnValue({ amount: BigInt(2_000_000) });

    const result = await checkTokenBalanceStep({
      ...input(),
      address: OFF_CURVE_WALLET,
    });

    expect(result.success).toBe(true);
  });

  it("threads the caller's userId into the Solana RPC provider", async () => {
    mockConnectionGetAccountInfo
      .mockResolvedValueOnce(fakeAccountInfo(TOKEN_PROGRAM_ID))
      .mockResolvedValueOnce(null);
    mockUnpackMint.mockReturnValue({ decimals: 6 });

    await checkTokenBalanceStep(input());

    expect(mockGetSolanaProvider).toHaveBeenCalledWith({
      chainId: 103,
      userId: "user_1",
    });
  });

  it("propagates a real RPC error instead of treating it as a zero balance", async () => {
    mockConnectionGetAccountInfo.mockRejectedValue(new Error("RPC timeout"));

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(false);
  });

  it("rejects a mint that is not owned by an SPL token program", async () => {
    const NOT_A_TOKEN_PROGRAM = new PublicKey(
      "11111111111111111111111111111111"
    );
    mockConnectionGetAccountInfo.mockResolvedValueOnce(
      fakeAccountInfo(NOT_A_TOKEN_PROGRAM)
    );

    const result = await checkTokenBalanceStep(input());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not an SPL token mint");
    }
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
    expect(mockConnectionGetAccountInfo).not.toHaveBeenCalled();
  });
});
