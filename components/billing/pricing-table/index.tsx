"use client";

import { ChevronDown, Info } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BillingInterval, PlanName } from "@/lib/billing/plans";
import { PLANS } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import {
  SPONSORSHIP_MAINNET_NAMES,
  SPONSORSHIP_TESTNET_NAMES,
} from "@/lib/web3/sponsorship-chains-meta";
import { PlanCard } from "./plan-card";
import type { PricingTableProps } from "./types";

type ComparisonRow = {
  label: string;
  tooltip?: {
    title: string;
    body: React.ReactNode;
  };
  free: string;
  pro: string;
  business: string;
  enterprise: string;
};

function formatGasCreditCap(planName: PlanName, capCents: number): string {
  if (planName === "enterprise") {
    return "Custom";
  }
  return `$${(capCents / 100).toFixed(0)}/mo`;
}

function buildSponsoredGasRow(
  gasCreditCaps?: Record<PlanName, number>
): ComparisonRow {
  const resolveCents = (planName: PlanName): number =>
    gasCreditCaps?.[planName] ?? PLANS[planName].features.gasCreditsCents;
  return {
    label: "Sponsored gas",
    tooltip: {
      title: "Sponsored via Turnkey Gas Station",
      body: (
        <>
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide opacity-70">
              Mainnets
            </p>
            <p>{SPONSORSHIP_MAINNET_NAMES.join(", ")}</p>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide opacity-70">
              Testnets
            </p>
            <p>{SPONSORSHIP_TESTNET_NAMES.join(", ")}</p>
          </div>
          <p className="opacity-70">
            Monthly cap of sponsored gas credits in USD. Transactions on other
            chains fall back to your wallet's native balance for gas.
          </p>
        </>
      ),
    },
    free: formatGasCreditCap("free", resolveCents("free")),
    pro: formatGasCreditCap("pro", resolveCents("pro")),
    business: formatGasCreditCap("business", resolveCents("business")),
    enterprise: formatGasCreditCap("enterprise", resolveCents("enterprise")),
  };
}

const STATIC_COMPARISON_ROWS: readonly ComparisonRow[] = [
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
];

function ComparisonRowLabel({
  row,
}: {
  row: ComparisonRow;
}): React.ReactElement {
  if (!row.tooltip) {
    return <>{row.label}</>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {row.label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={`Learn more about ${row.label}`}
            className="inline-flex items-center text-muted-foreground/70 transition-colors hover:text-foreground"
            type="button"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-2 px-3 py-2 text-left">
          <p className="font-medium">{row.tooltip.title}</p>
          {row.tooltip.body}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

function ComparisonTable({
  gasCreditCaps,
}: {
  gasCreditCaps?: Record<PlanName, number>;
}): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);

  const rows: ComparisonRow[] = [
    ...STATIC_COMPARISON_ROWS.slice(0, 3),
    buildSponsoredGasRow(gasCreditCaps),
    ...STATIC_COMPARISON_ROWS.slice(3),
  ];

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
              {rows.map((row, i) => (
                <tr
                  className={cn(
                    "border-b border-border/30 last:border-b-0",
                    i % 2 === 0 && "bg-muted/20"
                  )}
                  key={row.label}
                >
                  <td className="px-5 py-3 font-medium text-muted-foreground">
                    <ComparisonRowLabel row={row} />
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

      <ComparisonTable gasCreditCaps={gasCreditCaps} />

      <p className="text-center text-muted-foreground text-xs">
        Paid tiers bill overage at the end of the cycle. Free tier caps at its
        limit with no overage.
      </p>
    </div>
  );
}
