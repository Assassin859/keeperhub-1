"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { BillingInterval } from "@/lib/billing/plans";
import { PLANS } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import { PlanCard } from "./plan-card";
import type { PricingTableProps } from "./types";

const COMPARISON_ROWS = [
  {
    label: "Workflows",
    free: "Unlimited",
    pro: "Unlimited",
    business: "Unlimited",
    enterprise: "Unlimited",
  },
  {
    label: "Chains",
    free: "All EVM",
    pro: "All EVM",
    business: "All EVM",
    enterprise: "Custom",
  },
  {
    label: "Triggers",
    free: "Standard",
    pro: "Advanced",
    business: "Advanced + Custom",
    enterprise: "Custom",
  },
  {
    label: "API",
    free: "Rate-limited",
    pro: "Full",
    business: "Full",
    enterprise: "Full",
  },
  {
    label: "Logs",
    free: "7 days",
    pro: "30 days",
    business: "90 days",
    enterprise: "Custom",
  },
  {
    label: "Support",
    free: "Community",
    pro: "Email",
    business: "Dedicated",
    enterprise: "Dedicated (1h)",
  },
  {
    label: "SLA",
    free: "\u2014",
    pro: "\u2014",
    business: "99.9%",
    enterprise: "99.999%",
  },
  {
    label: "Builder",
    free: "Visual + AI",
    pro: "Visual + AI",
    business: "Visual + AI",
    enterprise: "Visual + AI",
  },
  {
    label: "MCP Server",
    free: "Included",
    pro: "Included",
    business: "Included",
    enterprise: "Included",
  },
  {
    label: "Ops team",
    free: "\u2014",
    pro: "\u2014",
    business: "\u2014",
    enterprise: "Dedicated",
  },
] as const;

function ComparisonTable(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mx-auto mt-6 max-w-7xl">
      <button
        className="mx-auto flex cursor-pointer items-center gap-2 text-keeperhub-green-dark text-sm transition-colors hover:text-keeperhub-green"
        onClick={() => setIsOpen((v) => !v)}
        type="button"
      >
        <span>{isOpen ? "Hide comparison" : "Compare all features"}</span>
        <ChevronDown
          className={cn(
            "size-4 transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {isOpen && (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-border/60 bg-sidebar">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60">
                <th className="w-[20%] px-5 py-3.5 text-left font-medium text-muted-foreground">
                  Feature
                </th>
                <th className="w-[20%] px-5 py-3.5 text-center font-medium">
                  Free
                </th>
                <th className="w-[20%] px-5 py-3.5 text-center font-medium">
                  Pro
                </th>
                <th className="w-[20%] px-5 py-3.5 text-center font-medium">
                  Business
                </th>
                <th className="w-[20%] px-5 py-3.5 text-center font-medium text-keeperhub-green-dark">
                  Enterprise
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row, i) => (
                <tr
                  className={cn(
                    "border-b border-border/30 last:border-b-0",
                    i % 2 === 0 && "bg-muted/20"
                  )}
                  key={row.label}
                >
                  <td className="px-5 py-3 font-medium text-muted-foreground">
                    {row.label}
                  </td>
                  <td className="px-5 py-3 text-center text-muted-foreground">
                    {row.free}
                  </td>
                  <td className="px-5 py-3 text-center">{row.pro}</td>
                  <td className="px-5 py-3 text-center">{row.business}</td>
                  <td className="px-5 py-3 text-center text-keeperhub-green-dark/90">
                    {row.enterprise}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PricingTable({
  currentPlan = "free",
  currentTier,
  currentInterval,
  gasCreditCaps,
  onPlanUpdated,
}: PricingTableProps): React.ReactElement {
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-center gap-3">
        <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-sidebar p-1">
          <button
            className={cn(
              "rounded-full px-5 py-2 font-medium text-sm transition-colors",
              interval === "monthly"
                ? "bg-keeperhub-green-dark text-white shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setInterval("monthly")}
            type="button"
          >
            Monthly
          </button>
          <button
            className={cn(
              "flex items-center gap-2 rounded-full px-5 py-2 font-medium text-sm transition-colors",
              interval === "yearly"
                ? "bg-keeperhub-green-dark text-white shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setInterval("yearly")}
            type="button"
          >
            Annual
          </button>
        </div>
        <Badge className="border border-keeperhub-green-dark/20 bg-keeperhub-green-dark/10 text-keeperhub-green-dark text-xs font-medium">
          Save 20%
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.free}
          planName="free"
        />
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.pro}
          planName="pro"
        />
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.business}
          planName="business"
        />
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.enterprise}
          planName="enterprise"
        />
      </div>

      <ComparisonTable />

      <p className="text-center text-muted-foreground text-xs">
        Paid tiers bill overage at the end of the cycle. Free tier caps at its
        limit with no overage.
      </p>
    </div>
  );
}
