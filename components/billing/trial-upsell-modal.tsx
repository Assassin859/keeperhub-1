"use client";

import { Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { type BillingInterval, PLANS, type TierKey } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import { getTierPrice, startCheckout } from "./pricing-table/utils";

const PRO = PLANS.pro;

// Plan-level Pro perks (execution volume is chosen per-tier below).
const PRO_BENEFITS: readonly string[] = [
  "Full API access",
  `${PRO.features.logRetentionDays}-day log retention`,
  `$${(PRO.features.gasCreditsCents / 100).toFixed(0)} sponsored gas / month`,
  "Email support",
  "Overage billing, no hard cap",
];

/**
 * Pro trial modal. Two modes:
 * - Start (default): offer a free trial to an eligible free org.
 * - Update (currentTier set): let a trialing org switch Pro tiers while the
 *   trial continues; the new tier is billed at trial end, $0 now.
 * Both send trial:true so the server keeps/starts the trial; plan cards never do.
 */
export function TrialUpsellModal({
  overlayId,
  days,
  usage,
  currentTier,
  currentInterval,
  onNeverShowAgain,
}: {
  overlayId: string;
  days: number;
  usage?: { executionsUsed: number; executionLimit: number };
  currentTier?: TierKey;
  currentInterval?: BillingInterval;
  onNeverShowAgain?: () => void;
}): React.ReactElement {
  const { close } = useOverlay();
  const isUpdate = currentTier != null;
  const [tier, setTier] = useState<TierKey>(currentTier ?? PRO.tiers[0].key);
  const [interval, setInterval] = useState<BillingInterval>(
    currentInterval ?? "monthly"
  );
  const [loading, setLoading] = useState(false);

  const activeTier = PRO.tiers.find((t) => t.key === tier) ?? PRO.tiers[0];
  const price = getTierPrice(activeTier, interval);
  const noChange = isUpdate && tier === currentTier;

  // Start mode leads with the reason the offer shows: nearing the free cap.
  const quotaLine =
    usage && usage.executionLimit > 0
      ? `You're reaching your free plan quota: ${usage.executionsUsed.toLocaleString()} of ${usage.executionLimit.toLocaleString()} executions used this month (${Math.round((usage.executionsUsed / usage.executionLimit) * 100)}%).`
      : "You're reaching your free plan quota.";

  async function handleSubmit(): Promise<void> {
    setLoading(true);
    try {
      // trial:true keeps/starts the trial; the server re-checks eligibility.
      const ok = await startCheckout("pro", tier, interval, { trial: true });
      // In update mode Stripe updates in place (no redirect); refresh the page
      // to reflect the new tier. Start mode redirects to Checkout instead.
      if (ok) {
        close(overlayId);
        window.location.reload();
      }
    } finally {
      setLoading(false);
    }
  }

  function dismiss(): void {
    close(overlayId);
  }

  function neverAgain(): void {
    onNeverShowAgain?.();
    close(overlayId);
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
        <div className="space-y-1.5">
          <span className="inline-flex items-center gap-2 rounded-full bg-keeperhub-green-dark/10 px-2.5 py-1 font-medium text-keeperhub-green-dark text-xs">
            <Sparkles className="size-3.5" />
            {isUpdate ? "On free trial" : `${days}-day free trial`}
          </span>
          <h2 className="font-bold text-2xl tracking-tight">
            {isUpdate
              ? "Manage your trial plan"
              : `Try Pro free for ${days} days`}
          </h2>
          {isUpdate ? (
            <p className="text-muted-foreground text-sm">
              Switch your Pro tier. Your trial continues and the new tier is
              billed when it ends.
            </p>
          ) : (
            <>
              <p className="font-medium text-foreground text-sm">{quotaLine}</p>
              <p className="text-muted-foreground text-sm">
                $0 today. Full access to Pro. Cancel anytime before the trial
                ends.
              </p>
            </>
          )}
        </div>
        <button
          aria-label="Close"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={dismiss}
          type="button"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="grid gap-6 px-6 pb-2 md:grid-cols-2">
        <ul className="space-y-2.5">
          {PRO_BENEFITS.map((benefit) => (
            <li className="flex items-start gap-2 text-sm" key={benefit}>
              <Check className="mt-0.5 size-4 shrink-0 text-keeperhub-green-dark" />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>

        <div className="space-y-3">
          {!isUpdate && (
            <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-sidebar p-1">
              {(["monthly", "yearly"] as const).map((value) => (
                <button
                  className={cn(
                    "rounded-full px-3 py-1 font-medium text-xs transition-colors",
                    interval === value
                      ? "bg-keeperhub-green-dark text-white"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={value}
                  onClick={() => setInterval(value)}
                  type="button"
                >
                  {value === "monthly" ? "Monthly" : "Annual"}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {PRO.tiers.map((t) => {
              const selected = t.key === tier;
              const isCurrent = t.key === currentTier;
              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors",
                    selected
                      ? "border-keeperhub-green-dark/60 bg-keeperhub-green-dark/10"
                      : "border-border/60 hover:border-keeperhub-green-dark/40"
                  )}
                  key={t.key}
                  onClick={() => setTier(t.key)}
                  type="button"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {t.executions.toLocaleString()} executions
                    {isCurrent && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase">
                        Current
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    ${getTierPrice(t, interval)}/mo
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-3 border-border/50 border-t px-6 py-4">
        <p className="text-muted-foreground text-xs">
          {isUpdate
            ? `No charge now. From the trial end, $${price}/mo.`
            : `After the trial, $${price}/mo. Cancel anytime before it ends and you will not be charged.`}
        </p>
        <Button
          className="w-full rounded-full"
          disabled={loading || noChange}
          onClick={handleSubmit}
        >
          {getButtonLabel({ isUpdate, loading, days })}
        </Button>
        <div className="flex items-center justify-between">
          {onNeverShowAgain ? (
            <button
              className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
              onClick={neverAgain}
              type="button"
            >
              Don&apos;t show again
            </button>
          ) : (
            <span />
          )}
          <button
            className="text-muted-foreground text-xs hover:text-foreground"
            onClick={dismiss}
            type="button"
          >
            {isUpdate ? "Cancel" : "Maybe later"}
          </button>
        </div>
      </div>
    </div>
  );
}

function getButtonLabel({
  isUpdate,
  loading,
  days,
}: {
  isUpdate: boolean;
  loading: boolean;
  days: number;
}): string {
  if (isUpdate) {
    return loading ? "Updating..." : "Update trial plan";
  }
  return loading ? "Redirecting..." : `Start ${days}-day free trial`;
}
