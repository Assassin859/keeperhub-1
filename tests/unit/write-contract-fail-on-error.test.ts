import { beforeEach, describe, expect, it, vi } from "vitest";

// Write Contract's failOnError toggle: when off, a failure encountered while
// attempting the on-chain send (signer/RPC/revert) is softened into
// { success: true, error, rejection?, errorClass? } so the workflow
// continues, mirroring HTTP Request's failOnError. Config/validation
// failures (errorClass USER/SYSTEM) always hard-fail regardless.

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

vi.mock("@/lib/utils/id", () => ({
  generateId: () => "test-unique-id",
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  resolveFailOnError: (failOnError: unknown) =>
    failOnError !== false && failOnError !== "false",
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn().mockReturnValue(1),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(),
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
  getAddressUrl: vi.fn(),
  getTxUrl: vi.fn(),
}));

vi.mock("@/lib/abi/struct-args", () => ({
  reshapeArgsForAbi: vi.fn().mockImplementation((args: unknown[]) => args),
  coerceArgsForAbi: vi.fn().mockImplementation((args: unknown[]) => args),
}));

vi.mock("@/lib/abi/validate-args", () => ({
  validateArgsForAbi: vi.fn().mockReturnValue({ ok: true }),
}));

vi.mock("@/lib/abi/utils", () => ({
  findAbiFunction: vi.fn().mockReturnValue({
    name: "work",
    stateMutability: "nonpayable",
  }),
}));

vi.mock("@/lib/abi/function-key", () => ({
  getAbiFunctionKey: vi.fn().mockReturnValue("work"),
}));

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn().mockReturnValue({
    executeContractCall: vi.fn(),
    getTransactionUrl: vi.fn(),
  }),
}));

vi.mock("@/lib/web3/decode-revert-error", () => ({
  formatContractError: vi
    .fn()
    .mockReturnValue("Contract call failed: Error(Splitter/kicked-too-soon)"),
  classifyRevert: vi.fn().mockReturnValue({ kind: "unknown" }),
}));

vi.mock("@/lib/web3/gas-defaults", () => ({
  resolveGasLimitOverrides: vi.fn().mockReturnValue({
    multiplierOverride: undefined,
    gasLimitOverride: undefined,
  }),
  parsePriorityFeeGwei: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn().mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: "user-1",
  }),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi
    .fn()
    .mockResolvedValue("0xwalletaddress1234567890123456789012345678"),
  initializeWalletSigner: vi.fn(),
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerMode: vi.fn(),
  resolveSignerForNode: vi.fn().mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xwalletaddress",
  }),
}));

vi.mock("@/lib/safe/execute-as-safe", () => ({
  executeContractCallAsSafe: vi.fn(),
  executeContractCallAsRole: vi.fn(),
}));

vi.mock("@/lib/web3/trace-executed-call", () => ({
  traceExecutedCallWithFailover: vi.fn(),
}));

vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: vi.fn(),
}));

vi.mock("@/lib/web3/sponsored-send-error", () => ({
  resolveSponsoredSendError: vi.fn(),
}));

vi.mock("@/lib/web3/sponsorship-feature-flag", () => ({
  isGasSponsorshipEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/web3/transaction-manager", () => ({
  withNonceSession: vi.fn(),
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
// Import SUT after all mocks
import {
  applyFailOnError,
  type WriteContractResult,
} from "@/plugins/web3/steps/write-contract-core";

describe("applyFailOnError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through a genuine success unchanged", () => {
    const success: WriteContractResult = {
      success: true,
      transactionHash: "0xhash",
      transactionLink: "https://etherscan.io/tx/0xhash",
      gasUsed: "1000",
      gasUsedUnits: "21000",
      effectiveGasPrice: "1000000000",
    };

    expect(applyFailOnError(success, undefined)).toEqual(success);
    expect(applyFailOnError(success, false)).toEqual(success);
  });

  it("hard-fails an execution error by default (failOnError unset)", () => {
    const failure: WriteContractResult = {
      success: false,
      error: "Contract call failed: Error(Splitter/kicked-too-soon)",
    };

    expect(applyFailOnError(failure, undefined)).toEqual(failure);
  });

  it("softens an execution error into success when failOnError is false", () => {
    const failure: WriteContractResult = {
      success: false,
      error: "Contract call failed: Error(Splitter/kicked-too-soon)",
    };

    expect(applyFailOnError(failure, false)).toEqual({
      success: true,
      error: "Contract call failed: Error(Splitter/kicked-too-soon)",
      rejection: undefined,
      errorClass: undefined,
    });
  });

  it("softens the string 'false' the same as boolean false", () => {
    const failure: WriteContractResult = {
      success: false,
      error: "RPC timeout",
    };

    const result = applyFailOnError(failure, "false");
    expect(result.success).toBe(true);
  });

  it("preserves rejection classification on a softened result", () => {
    const failure: WriteContractResult = {
      success: false,
      error: "Contract call failed: Error(Splitter/kicked-too-soon)",
      rejection: { kind: "custom-error", name: "KickedTooSoon" } as never,
    };

    const result = applyFailOnError(failure, false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rejection).toEqual({
        kind: "custom-error",
        name: "KickedTooSoon",
      });
    }
  });

  it("never softens a USER-classified validation error, even when failOnError is false", () => {
    const failure: WriteContractResult = {
      success: false,
      error: "Function 'work' not found in ABI",
      errorClass: ExecutionErrorType.USER,
    };

    expect(applyFailOnError(failure, false)).toEqual(failure);
  });

  it("never softens a SYSTEM-classified error, even when failOnError is false", () => {
    const failure: WriteContractResult = {
      success: false,
      error: "Failed to get wallet address",
      errorClass: ExecutionErrorType.SYSTEM,
    };

    expect(applyFailOnError(failure, false)).toEqual(failure);
  });
});
