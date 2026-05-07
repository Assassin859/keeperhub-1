import { describe, expect, it } from "vitest";
import { FREE_MARKETPLACE_BILLING_THRESHOLD_USDC } from "@/lib/billing/marketplace-billing";

describe("marketplace-billing", () => {
  it("threshold is 0.05 USDC", () => {
    expect(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC).toBe("0.05");
  });

  it("threshold parses as a number for numeric comparisons", () => {
    expect(Number(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC)).toBe(0.05);
  });

  describe("threshold comparison semantics (mirrors the marketplace call route)", () => {
    const threshold = Number(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC);

    it("treats prices below the threshold as not exempt", () => {
      expect(threshold <= 0.04).toBe(false);
      expect(threshold <= 0.0001).toBe(false);
      expect(threshold <= 0).toBe(false);
    });

    it("treats prices at or above the threshold as exempt", () => {
      expect(threshold <= 0.05).toBe(true);
      expect(threshold <= 0.5).toBe(true);
      expect(threshold <= 100).toBe(true);
    });
  });
});
