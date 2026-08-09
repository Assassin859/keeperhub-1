"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
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
  subscription: {
    plan: string;
    tier: string | null;
    interval: string | null;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  usage: { executionsUsed: number; executionLimit: number };
  gasCredits?: {
    totalCents: number;
    usedCents: number;
    remainingCents: number;
  };
};

export type BillingSummary = {
  plan: PlanName;
  tier: TierKey | null;
  interval: BillingInterval | null;
  status: string;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  executionsUsed: number;
  executionLimit: number;
  gasUsedCents: number;
  gasTotalCents: number;
};

export type BillingSummaryState = {
  summary: BillingSummary | null;
  loading: boolean;
  openingPortal: boolean;
  openPortal: () => Promise<void>;
};

export function useBillingSummary(): BillingSummaryState {
  const { revision } = useSettingsContext();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingPortal, setOpeningPortal] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(BILLING_API.SUBSCRIPTION);
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as SubscriptionResponse;
      setSummary({
        cancelAtPeriodEnd: data.subscription.cancelAtPeriodEnd,
        executionLimit: data.usage.executionLimit,
        executionsUsed: data.usage.executionsUsed,
        gasTotalCents: data.gasCredits?.totalCents ?? 0,
        gasUsedCents: data.gasCredits?.usedCents ?? 0,
        interval:
          data.subscription.interval === "monthly" ||
          data.subscription.interval === "yearly"
            ? data.subscription.interval
            : null,
        plan: parsePlanName(data.subscription.plan),
        renewsAt: data.subscription.currentPeriodEnd,
        status: data.subscription.status,
        tier: parseTierKey(data.subscription.tier),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, revision]);

  const openPortal = useCallback(async (): Promise<void> => {
    setOpeningPortal(true);
    try {
      const res = await fetch(BILLING_API.PORTAL, { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      toast.error(data.error ?? "Could not open the billing portal");
    } catch {
      toast.error("Could not open the billing portal");
    } finally {
      setOpeningPortal(false);
    }
  }, []);

  return { loading, openPortal, openingPortal, summary };
}
