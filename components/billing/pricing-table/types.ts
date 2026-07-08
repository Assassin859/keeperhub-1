import type {
  BillingInterval,
  PLANS,
  PlanName,
  TierKey,
} from "@/lib/billing/plans";

export type GasCreditCapsMap = Record<PlanName, number>;

// First-time-subscriber trial hint from the subscription API. Display only;
// the checkout route re-checks eligibility server-side.
export type TrialInfo = {
  eligible: boolean;
  days: number;
};

export type PricingTableProps = {
  currentPlan?: PlanName;
  currentTier?: TierKey | null;
  currentInterval?: BillingInterval | null;
  gasCreditCaps?: GasCreditCapsMap;
  onPlanUpdated?: () => Promise<void>;
};

export type PlanTierItem = (typeof PLANS)[PlanName]["tiers"][number];
