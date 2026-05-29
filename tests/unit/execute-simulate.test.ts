/**
 * Unit tests for lib/execute/simulate.ts.
 *
 * The simulate helpers route every chain call through
 * rpcManager.executeWithFailover (so a primary-RPC blip falls over to
 * the chain's fallback). These tests mock that boundary and assert:
 *
 *   - happy path: gas + decoded return value come back serialised
 *   - revert path: provider throws -> decoded reason in revertReason
 *   - input-validation paths short-circuit before any RPC call
 *   - simulateTokenTransfer resolves the token address via
 *     parseTokenAddress (same helper the broadcast path uses) and
 *     fetches on-chain decimals when not provided
 *
 * Run with: pnpm vitest tests/unit/execute-simulate.test.ts
 */

import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const FROM_ADDRESS = "0xaa0000000000000000000000000000000000aa00";
const CONTRACT_ADDRESS = "0xbb0000000000000000000000000000000000bb00";
const RECIPIENT_ADDRESS = "0xcc0000000000000000000000000000000000cc00";

// Hoisted spies so the vi.mock factories below can reference them.
const rpcSpies = vi.hoisted(() => ({
  executeWithFailover: vi.fn(),
  parseTokenAddress: vi.fn(),
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi.fn(() => Promise.resolve(FROM_ADDRESS)),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn(() => 1),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(() =>
    Promise.resolve({
      executeWithFailover: rpcSpies.executeWithFailover,
    })
  ),
}));

vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  parseTokenAddress: rpcSpies.parseTokenAddress,
}));

vi.mock("@/lib/logging", () => ({
  logSystemError: vi.fn(),
  ErrorCategory: { DATABASE: "database" },
}));

// Import after mocks so the simulate module binds to the stubbed deps.
import {
  simulateContractCall,
  simulateNativeTransfer,
  simulateTokenTransfer,
} from "@/lib/execute/simulate";

const { executeWithFailover, parseTokenAddress } = rpcSpies;

// Minimal ABI for a read with one address arg returning uint256.
const READ_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
]);

// Minimal ABI for a write with no return value (e.g. setValue(uint256)).
const WRITE_ABI = JSON.stringify([
  {
    type: "function",
    name: "setValue",
    inputs: [{ name: "value", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

function resetSpies(): void {
  executeWithFailover.mockReset();
  parseTokenAddress.mockReset();
}

describe("simulateContractCall", () => {
  it("returns gas + decoded return value when the call succeeds", async () => {
    resetSpies();
    // ABI-encoded uint256(123)
    const encoded123 =
      "0x000000000000000000000000000000000000000000000000000000000000007b";
    executeWithFailover.mockResolvedValueOnce([BigInt(45_000), encoded123]);

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: READ_ABI,
      functionName: "balanceOf",
      functionArgs: JSON.stringify([FROM_ADDRESS]),
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("simulated");
    expect(result.from).toBe(FROM_ADDRESS);
    expect(result.to).toBe(CONTRACT_ADDRESS);
    expect(result.wouldRevert).toBe(false);
    if (result.success) {
      expect(result.gasEstimate).toBe("45000");
      expect(result.simulatedReturnValue).toBe("123");
    }
    // Failover wrapper is used, not provider.call directly.
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "read"
    );
  });

  it("returns wouldRevert with a decoded reason when failover rejects", async () => {
    resetSpies();
    // Build a CALL_EXCEPTION-shaped error carrying a standard
    // Error(string) revert. Selector + ABI-encoded reason.
    const errorSelector = "0x08c379a0";
    const encodedReason = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string"],
      ["Insufficient balance"]
    );
    const revertError = { data: errorSelector + encodedReason.slice(2) };
    executeWithFailover.mockRejectedValueOnce(revertError);

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify(["999"]),
    });

    expect(result.success).toBe(false);
    expect(result.wouldRevert).toBe(true);
    if (!result.success) {
      expect(result.revertReason).toContain("Insufficient balance");
      expect(result.error).toBe(result.revertReason);
    }
  });

  it("returns wouldRevert when the ABI is not valid JSON", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: "not json",
      functionName: "setValue",
    });
    expect(result.success).toBe(false);
    expect(result.wouldRevert).toBe(true);
    if (!result.success) {
      expect(result.revertReason).toContain("ABI is not valid JSON");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionName is not in the ABI", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "nope",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("Function nope not found in ABI");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionArgs is not valid JSON", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: "not json",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("functionArgs is not valid JSON");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionArgs is not a JSON array", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify({ foo: "bar" }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain(
        "functionArgs must be a JSON array"
      );
    }
  });

  it("returns wouldRevert when value is not a valid ether amount", async () => {
    resetSpies();
    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      value: "not-a-number",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("Invalid value");
    }
  });
});

describe("simulateNativeTransfer", () => {
  it("returns gas estimate when the network accepts the transfer", async () => {
    resetSpies();
    executeWithFailover.mockResolvedValueOnce(BigInt(21_000));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.5",
    });

    expect(result.success).toBe(true);
    expect(result.wouldRevert).toBe(false);
    if (result.success) {
      expect(result.gasEstimate).toBe("21000");
      expect(result.from).toBe(FROM_ADDRESS);
      expect(result.to).toBe(RECIPIENT_ADDRESS);
      expect(result.simulatedReturnValue).toBeNull();
    }
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "read"
    );
  });

  it("returns wouldRevert when estimateGas throws", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(
      new Error("insufficient funds for gas * price + value")
    );

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.5",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("insufficient funds");
    }
  });

  it("rejects a malformed amount before touching the network", async () => {
    resetSpies();
    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "potato",
    });
    expect(result.success).toBe(false);
    expect(executeWithFailover).not.toHaveBeenCalled();
  });
});

describe("simulateTokenTransfer", () => {
  it("resolves the token via parseTokenAddress, fetches decimals on-chain, then simulates", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);
    // First failover call: decimals() returns uint8(6) (USDC).
    executeWithFailover.mockResolvedValueOnce(BigInt(6));
    // Second failover call: [estimateGas, returnData] for transfer.
    executeWithFailover.mockResolvedValueOnce([
      BigInt(65_000),
      // ABI-encoded bool(true)
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]);

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      // No tokenAddress; resolves via tokenConfig.
      tokenConfig: JSON.stringify({ supportedTokenId: "usdc-mainnet" }),
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "12.5",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe(CONTRACT_ADDRESS);
      expect(result.gasEstimate).toBe("65000");
      expect(result.simulatedReturnValue).toBe(true);
    }
    expect(parseTokenAddress).toHaveBeenCalledTimes(1);
    // decimals fetch + actual simulate = 2 failover invocations.
    expect(executeWithFailover).toHaveBeenCalledTimes(2);
    expect(executeWithFailover.mock.calls[0]?.[1]).toBe("preflight");
    expect(executeWithFailover.mock.calls[1]?.[1]).toBe("read");
  });

  it("skips the on-chain decimals lookup when decimals is provided", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);
    executeWithFailover.mockResolvedValueOnce([
      BigInt(65_000),
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]);

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenAddress: CONTRACT_ADDRESS,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "12.5",
      decimals: 6,
    });

    expect(result.success).toBe(true);
    // Only the simulate call, no decimals preflight.
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
    expect(executeWithFailover.mock.calls[0]?.[1]).toBe("read");
  });

  it("rejects when parseTokenAddress cannot resolve a token", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(null);

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenConfig: JSON.stringify({ mode: "popular" }),
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "100",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("resolvable");
    }
    // No RPC calls fire on a token-resolve failure.
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("rejects an amount that can't be parsed at the resolved decimals", async () => {
    resetSpies();
    parseTokenAddress.mockResolvedValueOnce(CONTRACT_ADDRESS);
    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenAddress: CONTRACT_ADDRESS,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "potato",
      decimals: 18,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("Invalid amount for 18 decimals");
    }
    expect(executeWithFailover).not.toHaveBeenCalled();
  });
});
