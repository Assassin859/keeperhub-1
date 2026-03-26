import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks -- must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      explorerConfigs: {
        findFirst: vi.fn().mockResolvedValue({
          chainId: 1,
          explorerUrl: "https://etherscan.io",
          explorerTxPath: "/tx/{hash}",
        }),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  explorerConfigs: { chainId: "chainId" },
}));

vi.mock("@/lib/explorer", () => ({
  getTransactionUrl: (_config: unknown, hash: string): string =>
    `https://etherscan.io/tx/${hash}`,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/para/wallet-helpers", () => ({
  initializeWalletSigner: vi.fn(),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProviderFromUrls: vi.fn(),
}));

const mockRecordTransaction = vi.fn().mockResolvedValue(undefined);
const mockConfirmTransaction = vi.fn().mockResolvedValue(undefined);
const mockGetNextNonce = vi.fn().mockReturnValue(42);

vi.mock("@/lib/web3/nonce-manager", () => ({
  getNonceManager: () => ({
    getNextNonce: mockGetNextNonce,
    recordTransaction: mockRecordTransaction,
    confirmTransaction: mockConfirmTransaction,
    startSession: vi.fn(),
    endSession: vi.fn(),
  }),
}));

vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import type { NonceSession } from "@/lib/web3/nonce-manager";
import {
  type SubmitAndConfirmOptions,
  submitAndConfirm,
  submitContractCallAndConfirm,
} from "@/lib/web3/transaction-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockReceipt(hash: string): {
  hash: string;
  gasUsed: bigint;
  gasPrice: bigint;
} {
  return { hash, gasUsed: BigInt(21_000), gasPrice: BigInt(10_000_000_000) };
}

function makeMockTxResponse(hash: string): {
  hash: string;
  wait: ReturnType<typeof vi.fn>;
} {
  return { hash, wait: vi.fn().mockResolvedValue(makeMockReceipt(hash)) };
}

function makeSession(): NonceSession {
  return {
    walletAddress: "0xABCD",
    chainId: 1,
    executionId: "exec-1",
    currentNonce: 42,
    startedAt: new Date(),
  };
}

function makeOptions(
  overrides?: Partial<SubmitAndConfirmOptions>
): SubmitAndConfirmOptions {
  return {
    rpcManager: {
      getFallbackProvider: vi.fn().mockReturnValue(null),
      getChainName: vi.fn().mockReturnValue("ethereum"),
    } as unknown as SubmitAndConfirmOptions["rpcManager"],
    session: makeSession(),
    nonce: 42,
    workflowId: "wf-1",
    chainId: 1,
    maxFeePerGas: BigInt(20_000_000_000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submitAndConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends on primary and returns result on success", async () => {
    const txResponse = makeMockTxResponse("0xhash1");
    const signer = {
      sendTransaction: vi.fn().mockResolvedValue(txResponse),
      connect: vi.fn(),
    };

    const result = await submitAndConfirm(
      signer as never,
      { to: "0xrecipient", value: BigInt(1000), nonce: 42 },
      makeOptions()
    );

    expect(result.txHash).toBe("0xhash1");
    expect(result.gasCostWei).toBe(
      (BigInt(21_000) * BigInt(10_000_000_000)).toString()
    );
    expect(result.transactionLink).toContain("0xhash1");
    expect(signer.connect).not.toHaveBeenCalled();
    expect(mockRecordTransaction).toHaveBeenCalledOnce();
    expect(mockConfirmTransaction).toHaveBeenCalledOnce();
  });

  it("throws immediately for non-retryable errors without trying fallback", async () => {
    const error = Object.assign(new Error("revert"), {
      code: "CALL_EXCEPTION",
    });
    const signer = {
      sendTransaction: vi.fn().mockRejectedValue(error),
      connect: vi.fn(),
    };

    await expect(
      submitAndConfirm(
        signer as never,
        { to: "0xrecipient", value: BigInt(1000), nonce: 42 },
        makeOptions()
      )
    ).rejects.toThrow("revert");

    expect(signer.connect).not.toHaveBeenCalled();
  });

  it("retries on fallback for retryable errors when fallback exists", async () => {
    const error = Object.assign(new Error("timeout"), {
      code: "NETWORK_ERROR",
    });
    const fallbackTx = makeMockTxResponse("0xfallback");
    const reconnectedSigner = {
      sendTransaction: vi.fn().mockResolvedValue(fallbackTx),
    };
    const signer = {
      sendTransaction: vi.fn().mockRejectedValue(error),
      connect: vi.fn().mockReturnValue(reconnectedSigner),
    };

    const fallbackProvider = { _isFallback: true };
    const rpcManager = {
      getFallbackProvider: vi.fn().mockReturnValue(fallbackProvider),
      getChainName: vi.fn().mockReturnValue("ethereum"),
    };

    const result = await submitAndConfirm(
      signer as never,
      { to: "0xrecipient", value: BigInt(1000), nonce: 42 },
      makeOptions({
        rpcManager:
          rpcManager as unknown as SubmitAndConfirmOptions["rpcManager"],
      })
    );

    expect(result.txHash).toBe("0xfallback");
    expect(signer.connect).toHaveBeenCalledWith(fallbackProvider);
    expect(reconnectedSigner.sendTransaction).toHaveBeenCalledOnce();
  });

  it("throws retryable error when no fallback provider exists", async () => {
    const error = Object.assign(new Error("timeout"), {
      code: "NETWORK_ERROR",
    });
    const signer = {
      sendTransaction: vi.fn().mockRejectedValue(error),
      connect: vi.fn(),
    };

    await expect(
      submitAndConfirm(
        signer as never,
        { to: "0xrecipient", value: BigInt(1000), nonce: 42 },
        makeOptions()
      )
    ).rejects.toThrow("timeout");

    expect(signer.connect).not.toHaveBeenCalled();
  });
});

describe("submitContractCallAndConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends contract call on primary and returns result on success", async () => {
    const txResponse = makeMockTxResponse("0xcontract1");
    const contract = {
      transfer: vi.fn().mockResolvedValue(txResponse),
      connect: vi.fn(),
    };
    const signer = { connect: vi.fn() };

    const result = await submitContractCallAndConfirm(
      contract as never,
      "transfer",
      ["0xrecipient", BigInt(1000)],
      { nonce: 42, gasLimit: BigInt(100_000) },
      signer as never,
      makeOptions()
    );

    expect(result.txHash).toBe("0xcontract1");
    expect(contract.connect).not.toHaveBeenCalled();
  });

  it("retries contract call on fallback for retryable errors", async () => {
    const error = Object.assign(new Error("timeout"), {
      code: "SERVER_ERROR",
    });
    const fallbackTx = makeMockTxResponse("0xfallbackContract");
    const reconnectedContract = {
      transfer: vi.fn().mockResolvedValue(fallbackTx),
    };
    const reconnectedSigner = {};
    const contract = {
      transfer: vi.fn().mockRejectedValue(error),
      connect: vi.fn().mockReturnValue(reconnectedContract),
    };
    const signer = {
      connect: vi.fn().mockReturnValue(reconnectedSigner),
    };

    const fallbackProvider = { _isFallback: true };
    const rpcManager = {
      getFallbackProvider: vi.fn().mockReturnValue(fallbackProvider),
      getChainName: vi.fn().mockReturnValue("ethereum"),
    };

    const result = await submitContractCallAndConfirm(
      contract as never,
      "transfer",
      ["0xrecipient", BigInt(1000)],
      { nonce: 42, gasLimit: BigInt(100_000) },
      signer as never,
      makeOptions({
        rpcManager:
          rpcManager as unknown as SubmitAndConfirmOptions["rpcManager"],
      })
    );

    expect(result.txHash).toBe("0xfallbackContract");
    expect(signer.connect).toHaveBeenCalledWith(fallbackProvider);
    expect(contract.connect).toHaveBeenCalledWith(reconnectedSigner);
    expect(reconnectedContract.transfer).toHaveBeenCalledOnce();
  });

  it("throws immediately for non-retryable contract errors", async () => {
    const error = Object.assign(new Error("invalid args"), {
      code: "INVALID_ARGUMENT",
    });
    const contract = {
      approve: vi.fn().mockRejectedValue(error),
      connect: vi.fn(),
    };
    const signer = { connect: vi.fn() };

    await expect(
      submitContractCallAndConfirm(
        contract as never,
        "approve",
        ["0xspender", BigInt(1000)],
        { nonce: 42 },
        signer as never,
        makeOptions()
      )
    ).rejects.toThrow("invalid args");

    expect(signer.connect).not.toHaveBeenCalled();
  });
});
