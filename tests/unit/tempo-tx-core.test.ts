import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { Abis } from "viem/tempo";

vi.mock("server-only", () => ({}));

// tempo-tx-core pulls the Turnkey / signer / wallet / RPC modules at import
// time; stub them so the pure helpers can be exercised without infra.
vi.mock("@/lib/turnkey/turnkey-client", () => ({
  getTurnkeySignerConfig: vi.fn(),
}));
vi.mock("@/lib/safe/signer-resolver", () => ({
  resolveSignerMode: vi.fn(),
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: vi.fn(),
}));
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: vi.fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: vi.fn(),
}));

import {
  buildTransferWithMemoCall,
  isTempoChain,
  normalizeMemo,
} from "@/plugins/tempo/steps/tempo-tx-core";

const ZERO_MEMO = `0x${"0".repeat(64)}`;
const USDC = "0x20c0000000000000000000000000000000000001" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;

describe("isTempoChain", () => {
  it("accepts Tempo mainnet and Moderato testnet", () => {
    expect(isTempoChain(4217)).toBe(true);
    expect(isTempoChain(42_431)).toBe(true);
  });

  it("rejects non-Tempo chains", () => {
    expect(isTempoChain(1)).toBe(false);
    expect(isTempoChain(8453)).toBe(false);
  });
});

describe("normalizeMemo", () => {
  it("returns a zero bytes32 for empty or missing memo", () => {
    expect(normalizeMemo(undefined)).toBe(ZERO_MEMO);
    expect(normalizeMemo("")).toBe(ZERO_MEMO);
    expect(normalizeMemo("   ")).toBe(ZERO_MEMO);
  });

  it("passes a 0x + 64-hex bytes32 through verbatim", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(normalizeMemo(hash)).toBe(hash);
  });

  it("right-pads a short plain-text memo (Solidity bytes32-string form)", () => {
    const memo = normalizeMemo("INV-1042");
    // "INV-1042" utf8 in the leading bytes, zero-padded on the right.
    expect(memo.startsWith("0x494e562d31303432")).toBe(true);
    expect(memo).toHaveLength(66);
    expect(memo.endsWith("00")).toBe(true);
  });

  it("throws when a plain-text memo exceeds 31 bytes", () => {
    expect(() => normalizeMemo("x".repeat(32))).toThrow(/too long/);
  });
});

describe("buildTransferWithMemoCall", () => {
  it("targets the token and encodes transferWithMemo(to, value, memo)", () => {
    const memo = normalizeMemo("INV-1042");
    const call = buildTransferWithMemoCall(USDC, RECIPIENT, BigInt(1_500_000), memo);

    expect(call.to).toBe(USDC);
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data });
    expect(decoded.functionName).toBe("transferWithMemo");
    expect(decoded.args).toEqual([RECIPIENT, BigInt(1_500_000), memo]);
  });
});
