import { beforeEach, describe, expect, it, vi } from "vitest";

const DIRECT_ID_PREFIX_REGEX = /^direct-/;

vi.mock("server-only", () => ({}));

vi.mock("@/lib/steps/step-handler", () => ({
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
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId", workflowId: "workflowId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
}));

// Mock generateId as a spy returning a deterministic test value
const mockGenerateId = vi.fn().mockReturnValue("test-unique-id");
vi.mock("@/lib/utils/id", () => ({
  generateId: () => mockGenerateId(),
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn().mockReturnValue(1),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn().mockResolvedValue({
    resolveActiveRpcUrl: vi.fn().mockResolvedValue("https://rpc.example.com"),
  }),
}));

vi.mock("ethers", () => ({
  ethers: {
    isAddress: vi.fn().mockReturnValue(true),
    Interface: vi.fn().mockImplementation(() => ({})),
    Contract: vi.fn().mockImplementation(() => ({})),
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    parseEther: vi.fn().mockReturnValue(BigInt(0)),
  },
}));

vi.mock("@/lib/explorer", () => ({
  getAddressUrl: vi.fn().mockReturnValue("https://etherscan.io/address/0x1234"),
  getTxUrl: vi.fn().mockReturnValue("https://etherscan.io/tx/0xhash"),
}));

vi.mock("@/lib/abi-struct-args", () => ({
  reshapeArgsForAbi: vi.fn().mockImplementation((args: unknown[]) => args),
}));

vi.mock("@/lib/web3/abi-function-key", () => ({
  getAbiFunctionKey: vi.fn().mockReturnValue("transfer"),
}));

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn().mockReturnValue({
    executeContractCall: vi.fn().mockResolvedValue({
      hash: "0xhash",
      gasUsed: BigInt(21_000),
      effectiveGasPrice: BigInt(1_000_000_000),
    }),
    getTransactionUrl: vi
      .fn()
      .mockResolvedValue("https://etherscan.io/tx/0xhash"),
  }),
}));

vi.mock("@/lib/web3/decode-revert-error", () => ({
  formatContractError: vi.fn().mockReturnValue("contract error"),
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: vi.fn().mockReturnValue({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn().mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: "user-1",
  }),
}));

vi.mock("@/lib/para/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi
    .fn()
    .mockResolvedValue("0xwalletaddress1234567890123456789012345678"),
  initializeWalletSigner: vi.fn().mockResolvedValue({
    getAddress: vi
      .fn()
      .mockResolvedValue("0xwalletaddress1234567890123456789012345678"),
  }),
}));

// Capture txContext passed to withNonceSession
let capturedTxContext: Record<string, unknown> | null = null;
vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: vi.fn(
    (
      txContext: Record<string, unknown>,
      _walletAddress: unknown,
      fn: (session: unknown) => unknown
    ) => {
      capturedTxContext = txContext;
      return fn({
        walletAddress: "0xwalletaddress",
        chainId: 1,
        executionId: txContext.executionId,
        currentNonce: 5,
        startedAt: new Date(),
      });
    }
  ),
}));

// Import mocks for assertion
import { initializeWalletSigner } from "@/lib/para/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";

// Import SUT after all mocks
import { writeContractCore } from "@/plugins/web3/steps/write-contract-core";

const VALID_ABI = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

describe("writeContractCore unique execution ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxContext = null;
    mockGenerateId.mockReturnValue("test-unique-id");
  });

  it("should generate unique execution ID when no context executionId provided", async () => {
    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(capturedTxContext).not.toBeNull();
    expect(capturedTxContext?.executionId).toMatch(DIRECT_ID_PREFIX_REGEX);
    expect(capturedTxContext?.executionId).not.toBe("direct-execution");
    expect(mockGenerateId).toHaveBeenCalled();
  });

  it("should use provided context executionId when available", async () => {
    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { executionId: "wf-exec-123", organizationId: "org-1" },
    });

    expect(capturedTxContext).not.toBeNull();
    expect(capturedTxContext?.executionId).toBe("wf-exec-123");
  });
});

describe("writeContractCore signer chain ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTxContext = null;
  });

  it("should pass resolved chainId to initializeWalletSigner", async () => {
    vi.mocked(getChainIdFromNetwork).mockReturnValue(11155111);

    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "11155111",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(initializeWalletSigner).toHaveBeenCalledWith(
      "org-1",
      "https://rpc.example.com",
      11155111
    );
  });

  it("should pass mainnet chainId when network is mainnet", async () => {
    vi.mocked(getChainIdFromNetwork).mockReturnValue(1);

    await writeContractCore({
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "1",
      abi: VALID_ABI,
      abiFunction: "transfer",
      _context: { organizationId: "org-1" },
    });

    expect(initializeWalletSigner).toHaveBeenCalledWith(
      "org-1",
      "https://rpc.example.com",
      1
    );
  });
});
