/**
 * Resolves which step-up factors a given action requires for a given user.
 *
 * Rules:
 *  - Email/TOTP users always use dual-factor (TOTP + email) on every gated
 *    action; this is not configurable and ignores `step_up_policy`.
 *  - Wallet (SIWE) users require a wallet signature by default, and can opt
 *    into additional enrolled factors per action via `step_up_policy`
 *    (e.g. require TOTP on withdrawals). A factor is only enforced if the
 *    user has actually enrolled it, so a stale policy can never lock them out.
 */

export type StepUpFactor = "wallet" | "totp" | "email";

/** Sensitive actions gated by step-up. Values match the `action` strings
 *  passed to requireStepUp / requireDualFactor across the route handlers. */
export const STEP_UP_ACTIONS = {
  walletWithdraw: "wallet_withdraw",
  walletExportKey: "wallet_export_key",
  apiKeyCreate: "user_api_key_create",
  apiKeyRevoke: "user_api_key_revoke",
  orgApiKeyCreate: "org_api_key_create",
  orgApiKeyRevoke: "org_api_key_revoke",
  emailChange: "email_change",
  passwordChange: "password_change",
  accountDeactivate: "account_deactivate",
} as const;

/** Per-action extra factors a wallet user opted into (beyond the base wallet
 *  signature). Stored in users.step_up_policy. */
export type StepUpPolicy = Record<string, StepUpFactor[]>;

export type EnrolledFactors = {
  /** Wallet address linked (SIWE). */
  wallet: boolean;
  /** TOTP authenticator enrolled. */
  totp: boolean;
  /** A verified, deliverable email on file. */
  email: boolean;
};

const ALLOWED_FACTORS: ReadonlySet<StepUpFactor> = new Set([
  "wallet",
  "totp",
  "email",
]);

/** Safely parse the jsonb column into a StepUpPolicy, dropping anything that
 *  doesn't match the expected shape. */
export function parseStepUpPolicy(value: unknown): StepUpPolicy {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: StepUpPolicy = {};
  for (const [action, factors] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (!Array.isArray(factors)) {
      continue;
    }
    const valid = factors.filter(
      (f): f is StepUpFactor =>
        typeof f === "string" && ALLOWED_FACTORS.has(f as StepUpFactor)
    );
    if (valid.length > 0) {
      result[action] = valid;
    }
  }
  return result;
}

export function resolveRequiredFactors(params: {
  isWalletUser: boolean;
  enrolled: EnrolledFactors;
  policy: StepUpPolicy | null | undefined;
  action: string;
}): StepUpFactor[] {
  const { isWalletUser, enrolled, policy, action } = params;

  // Email/TOTP accounts: mandatory dual-factor, not configurable.
  if (!isWalletUser) {
    return ["totp", "email"];
  }

  // Wallet accounts: base wallet signature + any enrolled, opted-in extras.
  const required = new Set<StepUpFactor>(["wallet"]);
  for (const factor of policy?.[action] ?? []) {
    if (factor === "totp" && enrolled.totp) {
      required.add("totp");
    }
    if (factor === "email" && enrolled.email) {
      required.add("email");
    }
  }
  return [...required];
}
