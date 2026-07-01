import { describe, expect, it } from "vitest";
import {
  parseStepUpPolicy,
  resolveRequiredFactors,
  STEP_UP_ACTIONS,
} from "@/lib/mfa/step-up-policy";

const WITHDRAW = STEP_UP_ACTIONS.walletWithdraw;
const API_KEY = STEP_UP_ACTIONS.apiKeyManage;

const enrolledAll = { wallet: true, totp: true, email: true };
const enrolledNoTotp = { wallet: true, totp: false, email: true };

describe("resolveRequiredFactors", () => {
  it("forces dual-factor for non-wallet accounts regardless of policy", () => {
    expect(
      resolveRequiredFactors({
        isWalletUser: false,
        enrolled: enrolledAll,
        policy: { [WITHDRAW]: [] },
        action: WITHDRAW,
      })
    ).toEqual(["totp", "email"]);
  });

  it("default-requires TOTP on withdraw when the wallet user has TOTP", () => {
    const factors = resolveRequiredFactors({
      isWalletUser: true,
      enrolled: enrolledAll,
      policy: null,
      action: WITHDRAW,
    });
    expect(factors).toContain("wallet");
    expect(factors).toContain("totp");
  });

  it("never blocks a wallet user without TOTP (signature only)", () => {
    expect(
      resolveRequiredFactors({
        isWalletUser: true,
        enrolled: enrolledNoTotp,
        policy: null,
        action: WITHDRAW,
      })
    ).toEqual(["wallet"]);
  });

  it("honors an explicit opt-out (empty array) of a default-on action", () => {
    expect(
      resolveRequiredFactors({
        isWalletUser: true,
        enrolled: enrolledAll,
        policy: { [WITHDRAW]: [] },
        action: WITHDRAW,
      })
    ).toEqual(["wallet"]);
  });

  it("lets an explicit policy override the default", () => {
    const factors = resolveRequiredFactors({
      isWalletUser: true,
      enrolled: enrolledAll,
      policy: { [WITHDRAW]: ["email"] },
      action: WITHDRAW,
    });
    expect(factors).toContain("email");
    expect(factors).not.toContain("totp");
  });

  it("adds no extra factor for a non-default action with no policy", () => {
    expect(
      resolveRequiredFactors({
        isWalletUser: true,
        enrolled: enrolledAll,
        policy: null,
        action: API_KEY,
      })
    ).toEqual(["wallet"]);
  });
});

describe("parseStepUpPolicy", () => {
  it("preserves an explicit empty array (opt-out)", () => {
    expect(parseStepUpPolicy({ [WITHDRAW]: [] })).toEqual({ [WITHDRAW]: [] });
  });

  it("drops invalid factors but keeps the action key", () => {
    expect(parseStepUpPolicy({ [WITHDRAW]: ["totp", "nope", 5] })).toEqual({
      [WITHDRAW]: ["totp"],
    });
  });

  it("returns an empty policy for non-object input", () => {
    expect(parseStepUpPolicy(null)).toEqual({});
    expect(parseStepUpPolicy("x")).toEqual({});
  });
});
