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
 *  passed to requireStepUp / requireDualFactor across the route handlers.
 *
 *  User-configurable actions (shown in wallet-security-section) live at the
 *  top. Internal-only actions (wallet security settings management, TOTP
 *  lifecycle) follow — they require step-up but are not user-configurable
 *  and therefore not surfaced in the policy UI. */
export const STEP_UP_ACTIONS = {
  // User-configurable via the security settings panel.
  walletWithdraw: "wallet_withdraw",
  walletExportKey: "wallet_export_key",
  // Create and revoke share one policy/challenge: managing an API key is a
  // single sensitive capability from the user's perspective.
  apiKeyManage: "user_api_key_manage",
  orgApiKeyManage: "org_api_key_manage",
  emailChange: "email_change",
  passwordChange: "password_change",
  accountDeactivate: "account_deactivate",
  auditExport: "audit_export",
  agenticWalletApprove: "agentic_wallet_approve",
  agenticWalletReject: "agentic_wallet_reject",
  sessionRevoke: "session_revoke",
  // Internal — not user-configurable.
  stepUpEmailEnroll: "step_up_email_enroll",
  stepUpEmailRemove: "step_up_email_remove",
  stepUpPolicyChange: "step_up_policy_change",
  totpDisable: "totp_disable",
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

/**
 * Default extra step-up factors for the highest-leverage wallet actions. A
 * wallet user who has TOTP enrolled is asked for it on withdraw / export-key by
 * default; a user without TOTP is never blocked (only enrolled factors are ever
 * enforced). The user can opt any action out in settings, stored as an explicit
 * empty array (see parseStepUpPolicy / resolveRequiredFactors).
 */
export const DEFAULT_STEP_UP_POLICY: StepUpPolicy = {
  [STEP_UP_ACTIONS.walletWithdraw]: ["totp"],
  [STEP_UP_ACTIONS.walletExportKey]: ["totp"],
};

/** Safely parse the jsonb column into a StepUpPolicy, dropping anything that
 *  doesn't match the expected shape. An explicit empty array is PRESERVED: it
 *  is the user's opt-out of a default-on action (distinct from an absent key,
 *  which means "use the default"). */
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
    result[action] = factors.filter(
      (f): f is StepUpFactor =>
        typeof f === "string" && ALLOWED_FACTORS.has(f as StepUpFactor)
    );
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

  // Wallet accounts: base wallet signature + extra factors. The user's explicit
  // per-action policy wins (an empty array is a deliberate opt-out); when the
  // action is unset, fall back to the default policy. Only enrolled factors are
  // ever enforced, so an unconfigured user is never blocked.
  const configured =
    policy && action in policy
      ? policy[action]
      : DEFAULT_STEP_UP_POLICY[action];
  const required = new Set<StepUpFactor>(["wallet"]);
  for (const factor of configured ?? []) {
    if (factor === "totp" && enrolled.totp) {
      required.add("totp");
    }
    if (factor === "email" && enrolled.email) {
      required.add("email");
    }
  }
  return [...required];
}
