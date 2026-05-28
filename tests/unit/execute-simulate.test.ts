/**
 * Unit tests for lib/execute/simulate.ts.
 *
 * Exercises the read-only simulator across the happy path
 * (estimateGas + provider.call succeed, return decoded), input-error
 * paths (bad JSON, missing function, encode failure), and the revert
 * path (provider throws -> reason decoded).
 *
 * Run with: pnpm vitest tests/unit/execute-simulate.test.ts
 */

import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const FROM_ADDRESS = "0xaa0000000000000000000000000000000000aa00";
const CONTRACT_ADDRESS = "0xbb0000000000000000000000000000000000bb00";
const RECIPIENT_ADDRESS = "0xcc0000000000000000000000000000000000cc00";

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWalletAddress: vi.fn(() => Promise.resolve(FROM_ADDRESS)),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: vi.fn(() => 1),
}));

// Provider stubs are mutated per-test so we can simulate success / revert.
const providerCall = vi.fn();
const providerEstimateGas = vi.fn();

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(() =>
    Promise.resolve({
      getProvider: () => ({
        call: providerCall,
        estimateGas: providerEstimateGas,
      }),
    })
  ),
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

// Minimal ABI for a read with one uint256 arg returning uint256.
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

function resetProvider(): void {
  providerCall.mockReset();
  providerEstimateGas.mockReset();
}

describe("simulateContractCall", () => {
  it("returns gas + decoded return value when the call succeeds", async () => {
    resetProvider();
    providerEstimateGas.mockResolvedValueOnce(BigInt(45_000));
    // ABI-encoded uint256(123)
    const encoded123 =
      "0x000000000000000000000000000000000000000000000000000000000000007b";
    providerCall.mockResolvedValueOnce(encoded123);

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
  });

  it("returns wouldRevert with a decoded reason when provider rejects", async () => {
    resetProvider();
    // Build a CALL_EXCEPTION-shaped error carrying a standard
    // Error(string) revert. Selector + ABI-encoded reason.
    const errorSelector = "0x08c379a0";
    const encodedReason = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string"],
      ["Insufficient balance"]
    );
    const revertError = { data: errorSelector + encodedReason.slice(2) };
    providerEstimateGas.mockRejectedValueOnce(revertError);
    providerCall.mockRejectedValueOnce(revertError);

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
    resetProvider();
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
    expect(providerEstimateGas).not.toHaveBeenCalled();
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionName is not in the ABI", async () => {
    resetProvider();
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
    expect(providerEstimateGas).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionArgs is not valid JSON", async () => {
    resetProvider();
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
    expect(providerEstimateGas).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when functionArgs is not a JSON array", async () => {
    resetProvider();
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
    resetProvider();
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
    resetProvider();
    providerEstimateGas.mockResolvedValueOnce(BigInt(21_000));

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
    // Native transfer never calls provider.call.
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("returns wouldRevert when estimateGas throws", async () => {
    resetProvider();
    providerEstimateGas.mockRejectedValueOnce(
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
    resetProvider();
    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "potato",
    });
    expect(result.success).toBe(false);
    expect(providerEstimateGas).not.toHaveBeenCalled();
  });
});

describe("simulateTokenTransfer", () => {
  it("encodes the ERC-20 transfer and delegates to simulateContractCall", async () => {
    resetProvider();
    providerEstimateGas.mockResolvedValueOnce(BigInt(65_000));
    // ABI-encoded bool(true)
    providerCall.mockResolvedValueOnce(
      "0x0000000000000000000000000000000000000000000000000000000000000001"
    );

    const result = await simulateTokenTransfer({
      organizationId: "org_test",
      network: "1",
      tokenAddress: CONTRACT_ADDRESS,
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "12.5",
      decimals: 6,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.to).toBe(CONTRACT_ADDRESS);
      expect(result.gasEstimate).toBe("65000");
      // The decoded ERC-20 transfer return is `true`.
      expect(result.simulatedReturnValue).toBe(true);
    }
  });

  it("rejects an amount that can't be parsed at the given decimals", async () => {
    resetProvider();
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
    expect(providerEstimateGas).not.toHaveBeenCalled();
  });
});
