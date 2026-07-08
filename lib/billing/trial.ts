import "server-only";

import type { OrganizationSubscription } from "@/lib/db/schema";
import type { PlanName } from "./plans";

// Plans that offer a first-time trial. Pro only for now.
const TRIAL_ELIGIBLE_PLANS = new Set<PlanName>(["pro"]);

const DEFAULT_TRIAL_DAYS = 14;
const MIN_TRIAL_DAYS = 1;
const MAX_TRIAL_DAYS = 90;

const DEFAULT_REPEAT_COOLDOWN_DAYS = 90;
const MIN_REPEAT_COOLDOWN_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether trial offers are turned on. Off by default -- trials are a deliberate
 * growth lever we enable per environment, not an always-on behavior.
 */
export function isTrialsEnabled(): boolean {
  return process.env.TRIALS_ENABLED === "true";
}

/**
 * Whether an org that already used a trial may start another one once its
 * cooldown has elapsed. Off by default: a trial is one-time unless we
 * deliberately re-open it (e.g. a win-back campaign months later).
 */
export function isRepeatTrialsEnabled(): boolean {
  return process.env.TRIAL_ALLOW_REPEAT === "true";
}

/**
 * Trial length in days, from STRIPE_TRIAL_PERIOD_DAYS (default 14), clamped to
 * a sane range so a misconfigured env can't create a zero-day or year-long trial.
 */
export function getTrialPeriodDays(): number {
  const raw =
    Number(process.env.STRIPE_TRIAL_PERIOD_DAYS) || DEFAULT_TRIAL_DAYS;
  return Math.min(MAX_TRIAL_DAYS, Math.max(MIN_TRIAL_DAYS, Math.floor(raw)));
}

/**
 * Days that must pass since an org's last trial before it can trial again
 * (only when repeat trials are enabled). From TRIAL_REPEAT_COOLDOWN_DAYS,
 * default 90. The clock resets each time a new trial starts.
 */
export function getTrialRepeatCooldownDays(): number {
  const raw =
    Number(process.env.TRIAL_REPEAT_COOLDOWN_DAYS) ||
    DEFAULT_REPEAT_COOLDOWN_DAYS;
  return Math.max(MIN_REPEAT_COOLDOWN_DAYS, Math.floor(raw));
}

// An org that already trialed becomes eligible again only if repeat trials are
// enabled AND its cooldown since the last trial has fully elapsed. This is what
// stops abuse: an org can't farm trials by subscribing/unsubscribing, but a
// genuinely cold org can be re-offered one after the window.
function repeatTrialAllowed(trialStartedAt: Date): boolean {
  if (!isRepeatTrialsEnabled()) {
    return false;
  }
  const cooldownMs = getTrialRepeatCooldownDays() * DAY_MS;
  return Date.now() - trialStartedAt.getTime() >= cooldownMs;
}

type TrialEligibilityInput = Pick<
  OrganizationSubscription,
  "plan" | "status" | "providerSubscriptionId" | "trialStartedAt"
>;

/**
 * Whether an org may start a trial for `targetPlan`.
 *
 * Never eligible while actively subscribed to a paid plan. A first-time org
 * (no prior trial, not a previously-subscribed-then-reset org) is eligible. An
 * org that already trialed is eligible again only via the repeat-trial cooldown.
 *
 * `sub` is undefined for a brand-new org with no subscription row yet.
 */
export function isTrialEligible(
  sub: TrialEligibilityInput | undefined,
  targetPlan: PlanName
): boolean {
  if (!(isTrialsEnabled() && TRIAL_ELIGIBLE_PLANS.has(targetPlan))) {
    return false;
  }
  if (!sub) {
    return true;
  }
  // Never while currently subscribed to a paid plan.
  if (sub.providerSubscriptionId != null || sub.plan !== "free") {
    return false;
  }
  // First-timer: never trialed, and not a previously-subscribed-then-reset org.
  if (sub.trialStartedAt == null) {
    return sub.status !== "canceled";
  }
  // Already trialed: only again after the cooldown.
  return repeatTrialAllowed(sub.trialStartedAt);
}
