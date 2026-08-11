"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BillingDetails } from "@/components/billing/billing-details";
import { BillingHistory } from "@/components/billing/billing-history";
import { PaygSection } from "@/components/billing/payg-section";
import { PAYG_PLAN_NAME } from "@/lib/billing/plans";
import { UsageMeter } from "./billing/usage-meter";
import { useBillingSummary } from "./hooks/use-billing-summary";
import { SectionHeader, SettingsCard, StatTile } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

const PLAN_LABELS: Record<string, string> = {
  business: "Business",
  enterprise: "Enterprise",
  free: "Free",
  pro: "Pro",
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "--";
}

export function BillingSection(): React.ReactElement {
  const { organizationId } = useSettingsContext();
  const { summary, loading, openPortal, openingPortal } = useBillingSummary();
  const isPaid = summary ? summary.plan !== "free" : false;
  const pending = loading || !summary;

  return (
    <>
      <SectionHeader
        action={
          <Button asChild>
            <Link href={`/settings/${organizationId}/plans`}>
              {isPaid ? "Change plan" : "Upgrade"}
            </Link>
          </Button>
        }
        description="What this organization is on right now, and how much of it you have used this month."
        title="Billing"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          hint={summary?.interval ? `Billed ${summary.interval}` : "No charge"}
          label="Current plan"
          loading={pending}
          value={summary ? (PLAN_LABELS[summary.plan] ?? summary.plan) : ""}
        />
        <StatTile
          hint={
            summary?.cancelAtPeriodEnd
              ? "Cancels at period end"
              : `Renews ${formatDate(summary?.renewsAt ?? null)}`
          }
          label="Status"
          loading={pending}
          tone={summary?.cancelAtPeriodEnd ? "warning" : "neutral"}
          value={
            summary?.status === "active" ? "Active" : (summary?.status ?? "")
          }
        />
        <StatTile
          hint="Billable runs this calendar month"
          label="Executions used"
          loading={pending}
          value={summary?.executionsUsed.toLocaleString() ?? ""}
        />
      </div>

      <SettingsCard
        description="Resets at the start of each calendar month."
        title="This month"
      >
        {loading || !summary ? (
          <FormSkeleton rows={2} />
        ) : (
          <div className="flex flex-col gap-5">
            <UsageMeter
              format={(v) => v.toLocaleString()}
              hint="Counts billable executions only."
              label="Executions"
              total={summary.executionLimit}
              used={summary.executionsUsed}
            />
            {summary.gasTotalCents > 0 && (
              <UsageMeter
                format={(v) => `$${(v / 100).toFixed(2)}`}
                hint="Gas sponsored by KeeperHub on supported networks."
                label="Gas sponsorship credits"
                total={summary.gasTotalCents}
                used={summary.gasUsedCents}
              />
            )}
          </div>
        )}
      </SettingsCard>

      {isPaid && (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <BillingHistory />
          <BillingDetails />
        </div>
      )}

      {summary?.plan === PAYG_PLAN_NAME && (
        <SettingsCard
          description="Keep a balance in USDC and spend it per execution, with no subscription. Top it up here."
          title="Pay as you go"
        >
          <PaygSection plan={summary.plan} />
        </SettingsCard>
      )}

      <SettingsCard
        description="The card on file, changed through the billing portal."
        title="Payment method"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={openingPortal || !isPaid}
            onClick={openPortal}
            variant="outline"
          >
            {openingPortal ? "Opening..." : "Manage payment method"}
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
        {!isPaid && (
          <p className="mt-3 text-muted-foreground text-xs">
            You are on the free plan, so there is no payment method on file yet.
          </p>
        )}
      </SettingsCard>
    </>
  );
}
