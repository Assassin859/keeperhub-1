/**
 * Unit tests for lib/execute/simulate.ts.
 *
 * The simulate helpers route every chain call through
 * rpcManager.executeWithFailover (so a primary-RPC blip falls over to
 * the chain's fallback). These tests mock that boundary and assert:
 *
 *   - happy path: gas + decoded return value come back serialised
 *   - revert path: provider throws -> decoded reason in revertReason
 *   - empty-wallet path: a revert-data-less estimateGas failure is
 *     attributed to the funding address with code "insufficient_balance",
 *     and is NOT claimed when the balance covers the value or cannot be read
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

// getNativeSymbol reads the chain's symbol from the seeded `chains` table.
// Only the insufficient-balance path touches it, and only for wording.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ symbol: "ETH" }]),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  chains: { chainId: "chain_id", symbol: "symbol" },
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
      "preflight"
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

  it("attributes an undecodable failure on a value-bearing call to an empty wallet", async () => {
    resetSpies();
    // No revert data to decode, and the wallet cannot cover the 1 ETH value.
    executeWithFailover.mockRejectedValueOnce(
      new Error('missing revert data (action="estimateGas")')
    );
    executeWithFailover.mockResolvedValueOnce(ethers.parseEther("0.25"));

    const result = await simulateContractCall({
      organizationId: "org_test",
      network: "1",
      contractAddress: CONTRACT_ADDRESS,
      abi: WRITE_ABI,
      functionName: "setValue",
      functionArgs: JSON.stringify(["1"]),
      value: "1.0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("insufficient_balance");
      expect(result.shortfallWei).toBe(ethers.parseEther("0.75").toString());
      expect(result.revertReason).toContain("Have: 0.25, Need: 1.0");
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
    // EOA recipient: estimateGas returns 21000, provider.call returns
    // "0x" (no return data), so simulatedReturnValue ends up null.
    executeWithFailover.mockResolvedValueOnce([BigInt(21_000), "0x"]);

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
      "preflight"
    );
  });

  it("surfaces return data when the recipient is a contract or precompile", async () => {
    resetSpies();
    // 32 bytes of zeros — what a SHA-256 precompile of empty input
    // would return.
    const precompileReturn = `0x${"00".repeat(32)}`;
    executeWithFailover.mockResolvedValueOnce([
      BigInt(24_338),
      precompileReturn,
    ]);

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.000005",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.gasEstimate).toBe("24338");
      expect(result.simulatedReturnValue).toBe(precompileReturn);
    }
  });

  it("returns wouldRevert when estimateGas throws", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(
      new Error("insufficient funds for gas * price + value")
    );
    // Balance covers the value, so the node's own message is the truthful
    // answer and must not be replaced by a shortfall claim.
    executeWithFailover.mockResolvedValueOnce(ethers.parseEther("10"));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.5",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("insufficient funds");
      expect(result.code).toBeUndefined();
    }
  });

  it("attributes a revert-data-less estimateGas failure to an empty wallet", async () => {
    resetSpies();
    // What Base (and most nodes) return when `from` cannot cover the value:
    // an error with no revert data, which ethers surfaces as a bare
    // CALL_EXCEPTION naming neither the balance nor the address.
    executeWithFailover.mockRejectedValueOnce(
      new Error(
        'missing revert data (action="estimateGas", data=null, reason=null, code=CALL_EXCEPTION, version=6.16.0)'
      )
    );
    executeWithFailover.mockResolvedValueOnce(BigInt(0));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.001",
    });

    expect(result.success).toBe(false);
    expect(result.wouldRevert).toBe(true);
    if (!result.success) {
      expect(result.code).toBe("insufficient_balance");
      expect(result.balanceWei).toBe("0");
      expect(result.requiredWei).toBe(ethers.parseEther("0.001").toString());
      expect(result.shortfallWei).toBe(ethers.parseEther("0.001").toString());
      expect(result.nativeSymbol).toBe("ETH");
      // The message has to carry the two facts the caller cannot look up:
      // which address to fund, and by how much.
      expect(result.revertReason).toContain(FROM_ADDRESS);
      expect(result.revertReason).toContain("Have: 0.0, Need: 0.001");
      expect(result.revertReason).toContain("at least 0.001 ETH");
      expect(result.error).toBe(result.revertReason);
    }
    // One estimateGas/call round trip, then exactly one balance read.
    expect(executeWithFailover).toHaveBeenCalledTimes(2);
  });

  it("keeps the original error when the balance read itself fails", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(new Error("node exploded"));
    executeWithFailover.mockRejectedValueOnce(new Error("balance read failed"));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0.001",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.revertReason).toContain("node exploded");
      expect(result.code).toBeUndefined();
    }
  });

  it("does not read the balance for a zero-value transfer", async () => {
    resetSpies();
    executeWithFailover.mockRejectedValueOnce(new Error("node exploded"));

    const result = await simulateNativeTransfer({
      organizationId: "org_test",
      network: "1",
      recipientAddress: RECIPIENT_ADDRESS,
      amount: "0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBeUndefined();
    }
    // A zero-value call cannot be short of funds: no extra round trip.
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
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
    expect(executeWithFailover.mock.calls[1]?.[1]).toBe("preflight");
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
    expect(executeWithFailover.mock.calls[0]?.[1]).toBe("preflight");
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
