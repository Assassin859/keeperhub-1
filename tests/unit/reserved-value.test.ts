import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseNativeValueWei,
  parseNodeNativeValueWei,
} from "@/app/api/execute/_lib/reserved-value";

describe("parseNativeValueWei", () => {
  it("parses a decimal ETH amount to wei", () => {
    expect(parseNativeValueWei("1.5")).toEqual({
      ok: true,
      valueWei: "1500000000000000000",
    });
  });

  it("treats undefined/null/empty as 0", () => {
    expect(parseNativeValueWei(undefined)).toEqual({ ok: true, valueWei: "0" });
    expect(parseNativeValueWei(null)).toEqual({ ok: true, valueWei: "0" });
    expect(parseNativeValueWei("")).toEqual({ ok: true, valueWei: "0" });
  });

  it("rejects a non-numeric amount", () => {
    expect(parseNativeValueWei("abc").ok).toBe(false);
  });

  it("rejects a negative amount (would bank credit against the cap)", () => {
    // ethers.parseEther("-5") returns a negative BigInt without throwing.
    expect(parseNativeValueWei("-5").ok).toBe(false);
  });

  it("rejects more than 18 decimals", () => {
    expect(parseNativeValueWei("1.0000000000000000001").ok).toBe(false);
  });
});

describe("parseNodeNativeValueWei", () => {
  it("charges a native transfer's amount", () => {
    expect(
      parseNodeNativeValueWei("transferFundsStep", { amount: "2" })
    ).toEqual({ ok: true, valueWei: "2000000000000000000" });
  });

  it("charges a contract write's ethValue", () => {
    expect(
      parseNodeNativeValueWei("writeContractStep", { ethValue: "0.1" })
    ).toEqual({ ok: true, valueWei: "100000000000000000" });
  });

  it("ignores a token transfer's amount (no native value moved)", () => {
    expect(
      parseNodeNativeValueWei("transferTokenStep", { amount: "1000000" })
    ).toEqual({ ok: true, valueWei: "0" });
  });

  it("reserves 0 for off-chain / unrecognized steps", () => {
    expect(parseNodeNativeValueWei("httpRequestStep", { amount: "5" })).toEqual(
      { ok: true, valueWei: "0" }
    );
  });

  it("propagates a parse failure for a value-bearing step", () => {
    expect(
      parseNodeNativeValueWei("transferFundsStep", { amount: "-5" }).ok
    ).toBe(false);
  });
});
