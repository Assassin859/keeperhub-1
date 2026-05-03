import { describe, expect, it } from "vitest";
import { clampSponsoredFees } from "@/lib/web3/sponsored-fee-clamp";

describe("clampSponsoredFees", () => {
  // KEEP-394: Pimlico's getUserOperationGasPrice has been observed
  // returning an invalid pair on Sepolia. Mirror the KEEP-384 regression
  // test for the direct-signing path.
  it("lifts maxFeePerGas to maxPriorityFeePerGas when given an invalid pair", () => {
    // Wei values from a reported Sepolia incident (chainId 11155111).
    const fees = {
      maxFeePerGas: BigInt(2_463_760),
      maxPriorityFeePerGas: BigInt(100_000_000),
    };

    const clamped = clampSponsoredFees(fees);

    expect(clamped.maxFeePerGas).toBeGreaterThanOrEqual(
      clamped.maxPriorityFeePerGas
    );
    expect(clamped.maxPriorityFeePerGas).toBe(BigInt(100_000_000));
    expect(clamped.maxFeePerGas).toBe(BigInt(100_000_000));
  });

  it("preserves a valid pair unchanged", () => {
    const fees = {
      maxFeePerGas: BigInt(50_000_000_000),
      maxPriorityFeePerGas: BigInt(2_000_000_000),
    };

    const clamped = clampSponsoredFees(fees);

    expect(clamped).toBe(fees);
  });

  it("preserves an exactly equal pair unchanged", () => {
    const fees = {
      maxFeePerGas: BigInt(1_000_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000_000),
    };

    const clamped = clampSponsoredFees(fees);

    expect(clamped.maxFeePerGas).toBe(clamped.maxPriorityFeePerGas);
    expect(clamped).toBe(fees);
  });

  it("returns a valid pair when both values are zero", () => {
    const fees = {
      maxFeePerGas: BigInt(0),
      maxPriorityFeePerGas: BigInt(0),
    };

    const clamped = clampSponsoredFees(fees);

    expect(clamped.maxFeePerGas).toBe(BigInt(0));
    expect(clamped.maxPriorityFeePerGas).toBe(BigInt(0));
  });

  it("handles the boundary case where maxFee is one wei below priority", () => {
    const fees = {
      maxFeePerGas: BigInt(99_999_999),
      maxPriorityFeePerGas: BigInt(100_000_000),
    };

    const clamped = clampSponsoredFees(fees);

    expect(clamped.maxFeePerGas).toBe(BigInt(100_000_000));
    expect(clamped.maxPriorityFeePerGas).toBe(BigInt(100_000_000));
  });

  it("preserves the boundary case where maxFee is one wei above priority", () => {
    const fees = {
      maxFeePerGas: BigInt(100_000_001),
      maxPriorityFeePerGas: BigInt(100_000_000),
    };

    const clamped = clampSponsoredFees(fees);

    expect(clamped).toBe(fees);
  });
});
