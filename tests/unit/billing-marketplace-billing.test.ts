import { describe, expect, it } from "vitest";
import {
  FREE_MARKETPLACE_BILLING_THRESHOLD_USDC,
  isWorkflowBillable,
} from "@/lib/billing/marketplace-billing";

describe("marketplace-billing", () => {
  it("threshold is 0.05 USDC", () => {
    expect(FREE_MARKETPLACE_BILLING_THRESHOLD_USDC).toBe("0.05");
  });

  describe("isWorkflowBillable", () => {
    it("returns true for unlisted workflows regardless of price", () => {
      expect(
        isWorkflowBillable({ isListed: false, priceUsdcPerCall: "0.50" })
      ).toBe(true);
      expect(
        isWorkflowBillable({ isListed: null, priceUsdcPerCall: "1.00" })
      ).toBe(true);
    });

    it("returns true for listed workflows priced below the threshold", () => {
      expect(
        isWorkflowBillable({ isListed: true, priceUsdcPerCall: "0.04" })
      ).toBe(true);
      expect(
        isWorkflowBillable({ isListed: true, priceUsdcPerCall: "0.0001" })
      ).toBe(true);
      expect(
        isWorkflowBillable({ isListed: true, priceUsdcPerCall: "0" })
      ).toBe(true);
      expect(
        isWorkflowBillable({ isListed: true, priceUsdcPerCall: null })
      ).toBe(true);
    });

    it("returns false for listed workflows at or above the threshold", () => {
      expect(
        isWorkflowBillable({ isListed: true, priceUsdcPerCall: "0.05" })
      ).toBe(false);
      expect(
        isWorkflowBillable({ isListed: true, priceUsdcPerCall: "0.50" })
      ).toBe(false);
      expect(
        isWorkflowBillable({ isListed: true, priceUsdcPerCall: "100" })
      ).toBe(false);
    });
  });
});
