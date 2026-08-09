"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  GasCreditCapsMap,
  TrialInfo,
} from "@/components/billing/pricing-table/types";
import { BILLING_API } from "@/lib/billing/constants";
import {
  type BillingInterval,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "@/lib/billing/plans";
import { useSettingsContext } from "../settings-context";

type SubscriptionResponse = {
  subscription: { plan: string; tier: string | null; interval: string | null };
  gasCreditCaps?: GasCreditCapsMap;
  trial?: TrialInfo;
};

export type BillingPlanState = {
  plan: PlanName;
  tier: TierKey | null;
  interval: BillingInterval | null;
  gasCreditCaps: GasCreditCapsMap | undefined;
  trial: TrialInfo | undefined;
  loading: boolean;
  /** Bumped after a plan change so the child panels remount and refetch. */
  refreshKey: number;
  refresh: () => Promise<void>;
};

export function useBillingPlan(): BillingPlanState {
  const { organizationId, revision } = useSettingsContext();
  const [plan, setPlan] = useState<PlanName>("free");
  const [tier, setTier] = useState<TierKey | null>(null);
  const [interval, setInterval] = useState<BillingInterval | null>(null);
  const [gasCreditCaps, setGasCreditCaps] = useState<
    GasCreditCapsMap | undefined
  >(undefined);
  const [trial, setTrial] = useState<TrialInfo | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchPlan = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch(BILLING_API.SUBSCRIPTION);
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as SubscriptionResponse;
      setPlan(parsePlanName(data.subscription.plan));
      setTier(parseTierKey(data.subscription.tier));
      setInterval(
        data.subscription.interval === "monthly" ||
          data.subscription.interval === "yearly"
          ? data.subscription.interval
          : null
      );
      setGasCreditCaps(data.gasCreditCaps);
      setTrial(data.trial);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPlan("free");
    setTier(null);
    setInterval(null);
    setTrial(undefined);
    setRefreshKey((k) => k + 1);
    fetchPlan().catch(() => undefined);
  }, [fetchPlan, organizationId, revision]);

  const refresh = useCallback(async (): Promise<void> => {
    await fetchPlan();
    setRefreshKey((k) => k + 1);
  }, [fetchPlan]);

  return {
    gasCreditCaps,
    interval,
    loading,
    plan,
    refresh,
    refreshKey,
    tier,
    trial,
  };
}
