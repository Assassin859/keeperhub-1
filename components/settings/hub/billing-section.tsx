"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
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
        title="Billing and plan"
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

      <SettingsCard
        description="Invoices, payment method and the full plan comparison live in the billing portal."
        title="Payment and invoices"
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
          <Button asChild variant="outline">
            <Link href="/billing">Invoices and plans</Link>
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
