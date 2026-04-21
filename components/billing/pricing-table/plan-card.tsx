"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import type {
  BillingInterval,
  PLANS,
  PlanName,
  TierKey,
} from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import { ConfirmPlanChangeDialog } from "../confirm-plan-change-dialog";
import {
  HeroMetrics,
  PlanCardBadge,
  PlanCardFooter,
  PlanHeader,
  TierSelect,
} from "./plan-card-parts";
import type { GasCreditCapsMap } from "./types";
import {
  cancelSubscription,
  computeDisplayPrice,
  isCurrentPlan,
  resolveExecutions,
  startCheckout,
} from "./utils";

export function PlanCard({
  plan,
  planName,
  interval,
  currentPlan,
  currentTier,
  currentInterval,
  gasCreditCaps,
  onPlanUpdated,
}: {
  plan: (typeof PLANS)[PlanName];
  planName: PlanName;
  interval: BillingInterval;
  currentPlan?: PlanName;
  currentTier?: TierKey | null;
  currentInterval?: BillingInterval | null;
  gasCreditCaps?: GasCreditCapsMap;
  onPlanUpdated?: () => Promise<void>;
}): React.ReactElement {
  const [selectedTier, setSelectedTier] = useState<TierKey | null>(
    currentPlan === planName && currentTier
      ? currentTier
      : (plan.tiers[0]?.key ?? null)
  );
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const hasSubscription = currentPlan !== undefined && currentPlan !== "free";
  const isEnterprise = planName === "enterprise";
  const isFree = planName === "free";

  const isCurrent = isCurrentPlan(
    planName,
    selectedTier,
    interval,
    currentPlan,
    currentTier,
    currentInterval
  );

  const activeTier = plan.tiers.find((t) => t.key === selectedTier);
  const price = computeDisplayPrice(planName, activeTier, interval);

  const capCents = gasCreditCaps?.[planName] ?? plan.features.gasCreditsCents;
  const gasDisplay = isEnterprise
    ? "Custom"
    : `$${(capCents / 100).toFixed(0)}`;

  const executionsDisplay = (() => {
    if (isEnterprise) {
      return "Custom";
    }
    if (isFree) {
      return plan.features.maxExecutionsPerMonth.toLocaleString();
    }
    if (activeTier) {
      return activeTier.executions.toLocaleString();
    }
    return "-";
  })();

  async function executeCheckout(): Promise<void> {
    setLoading(true);
    try {
      if (isFree) {
        const result = await cancelSubscription();
        if (!result.success) {
          return;
        }
        if (result.periodEnd) {
          const endDate = new Intl.DateTimeFormat("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          }).format(new Date(result.periodEnd));
          toast.success(
            `Your subscription will cancel on ${endDate}. You keep your current plan until then.`
          );
        } else {
          toast.success("Subscription canceled.");
        }
        setConfirmOpen(false);
        await onPlanUpdated?.();
        return;
      }
      const updated = await startCheckout(planName, selectedTier, interval);
      if (updated) {
        setConfirmOpen(false);
        await onPlanUpdated?.();
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubscribe(): void {
    if (isEnterprise) {
      window.open(
        "mailto:human@keeperhub.com?subject=Enterprise%20Plan",
        "_blank",
        "noopener"
      );
      return;
    }
    if (isCurrent) {
      return;
    }
    if (isFree && hasSubscription) {
      setConfirmOpen(true);
      return;
    }
    if (isFree) {
      return;
    }
    if (hasSubscription) {
      setConfirmOpen(true);
      return;
    }
    executeCheckout().catch(() => {
      // handled inside executeCheckout
    });
  }

  const tierLabel = activeTier
    ? `${activeTier.executions.toLocaleString()} executions`
    : null;

  const currentExecutions = resolveExecutions(currentPlan, currentTier);
  const newExecutions = resolveExecutions(planName, selectedTier);

  return (
    <>
      <ConfirmPlanChangeDialog
        currentExecutions={currentExecutions}
        currentPlanName={currentPlan ?? "free"}
        gasCreditCaps={gasCreditCaps}
        interval={interval}
        newExecutions={newExecutions}
        newPlanName={planName}
        newTier={selectedTier}
        onConfirm={executeCheckout}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        planName={plan.name}
        price={price ?? 0}
        tierLabel={tierLabel}
      />
      <Card
        className={cn(
          "group relative flex flex-col border border-border/50 bg-sidebar p-2 transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_0_24px_rgba(0,255,100,0.08)]",
          currentPlan === planName && "border-keeperhub-green-dark/60"
        )}
      >
        <PlanCardBadge isActive={currentPlan === planName} />

        <CardContent className="flex flex-1 flex-col gap-0 pt-6">
          <PlanHeader
            isEnterprise={isEnterprise}
            name={plan.name}
            price={price}
          />

          <HeroMetrics executions={executionsDisplay} gas={gasDisplay} />

          {plan.tiers.length > 0 && (
            <TierSelect
              interval={interval}
              onChange={(key) => setSelectedTier(key as TierKey)}
              options={plan.tiers}
              value={selectedTier ?? plan.tiers[0].key}
            />
          )}
        </CardContent>

        <PlanCardFooter
          currentPlan={currentPlan}
          hasSubscription={hasSubscription}
          isCurrent={isCurrent}
          loading={loading}
          onSubscribe={handleSubscribe}
          plan={plan}
          planName={planName}
        />
      </Card>
    </>
  );
}
