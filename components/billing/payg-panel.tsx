"use client";

import { Loader2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { BILLING_API } from "@/lib/billing/constants";
import { PLANS } from "@/lib/billing/plans";
import { useOrganization } from "@/lib/hooks/use-organization";

type PaygStatus = {
  enabled: boolean;
  priceUsdc: string;
  treasuryConfigured: boolean;
  chainId: number;
  caps: { dailyUsdc: string; periodUsdc: string };
  usage: {
    periodStart: string;
    periodEnd: string;
    periodExecutions: number;
    periodSpentUsdc: string;
    dailySpentUsdc: string;
  } | null;
  history: {
    executionId: string;
    amountUsdc: string;
    txHash: string | null;
    chainId: number;
    createdAt: string;
  }[];
};

// Cheapest paid tier of each fixed plan, for the comparison. `perExecution` is
// the plan's overage rate (ratePerThousand / 1000) -- the cost of an execution
// beyond the included limit, which is what the per-execution column shows.
const COMPARISON_PLANS = [
  {
    name: "Pro",
    included: PLANS.pro.tiers[0]?.executions ?? 0,
    monthlyPrice: PLANS.pro.tiers[0]?.monthlyPrice ?? 0,
    perExecution: PLANS.pro.overage.ratePerThousand / 1000,
  },
  {
    name: "Business",
    included: PLANS.business.tiers[0]?.executions ?? 0,
    monthlyPrice: PLANS.business.tiers[0]?.monthlyPrice ?? 0,
    perExecution: PLANS.business.overage.ratePerThousand / 1000,
  },
] as const;

/** Free-tier included executions -- the bucket PAYG covers overflow beyond. */
const FREE_LIMIT = PLANS.free.features.maxExecutionsPerMonth;

function formatUsdc(decimal: string): string {
  return `$${Number(decimal).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })}`;
}

function formatPerExec(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Blank a "0" cap for the input; anything else round-trips as-is. */
function capToInput(decimal: string): string {
  return Number(decimal) === 0 ? "" : decimal;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function PaygPanel(): React.ReactElement | null {
  const { organization } = useOrganization();
  const orgId = organization?.id;

  const [status, setStatus] = useState<PaygStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dailyCap, setDailyCap] = useState("");
  const [periodCap, setPeriodCap] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(BILLING_API.PAYG);
      if (res.status === 404) {
        setStatus(null);
        return;
      }
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const data = (await res.json()) as PaygStatus;
      setStatus(data);
      setDailyCap(capToInput(data.caps.dailyUsdc));
      setPeriodCap(capToInput(data.caps.periodUsdc));
    } catch (error) {
      console.error("[PaygPanel] Failed to load status:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: orgId re-triggers on org switch
  useEffect(() => {
    load().catch(() => undefined);
  }, [load, orgId]);

  async function save(enabling: boolean): Promise<void> {
    setSaving(true);
    try {
      const res = await fetch(BILLING_API.PAYG, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyCapUsdc: dailyCap,
          periodCapUsdc: periodCap,
        }),
      });
      const data = (await res.json()) as PaygStatus & { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Could not update pay-as-you-go");
        return;
      }
      setStatus(data);
      setDailyCap(capToInput(data.caps.dailyUsdc));
      setPeriodCap(capToInput(data.caps.periodUsdc));
      toast.success(enabling ? "Pay-as-you-go enabled" : "Spending caps saved");
    } catch (error) {
      console.error("[PaygPanel] Save failed:", error);
      toast.error("Could not update pay-as-you-go");
    } finally {
      setSaving(false);
    }
  }

  async function disable(): Promise<void> {
    setSaving(true);
    try {
      const res = await fetch(BILLING_API.PAYG, { method: "DELETE" });
      const data = (await res.json()) as PaygStatus & { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Could not disable pay-as-you-go");
        return;
      }
      setStatus(data);
      toast.success("Pay-as-you-go disabled");
    } catch (error) {
      console.error("[PaygPanel] Disable failed:", error);
      toast.error("Could not disable pay-as-you-go");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !status) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading pay-as-you-go...
        </CardContent>
      </Card>
    );
  }

  if (!status) {
    return null;
  }

  const price = Number(status.priceUsdc);
  const priceConfigured = price > 0;
  const available = status.treasuryConfigured && priceConfigured;
  // Break-even vs upgrading to the cheapest paid plan: the free bucket plus the
  // overflow count whose per-execution charges equal that plan's monthly fee.
  const breakEvenRuns = priceConfigured
    ? FREE_LIMIT + Math.round(COMPARISON_PLANS[0].monthlyPrice / price)
    : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Zap className="size-5 text-keeperhub-green-dark" />
            <CardTitle>Pay as you go</CardTitle>
            {status.enabled && (
              <Badge className="border border-keeperhub-green-dark/20 bg-keeperhub-green-dark/10 text-keeperhub-green-dark">
                Active
              </Badge>
            )}
          </div>
          <Badge className="border border-border/60 bg-muted/40 text-muted-foreground">
            {FREE_LIMIT.toLocaleString()} free / mo
          </Badge>
        </div>
        <CardDescription>
          Keep your workflows running past your {FREE_LIMIT.toLocaleString()}{" "}
          free executions each month. Beyond the limit, each execution is
          charged in USDC from your organization wallet, with no monthly fee.
          Premium nodes still require a paid plan.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {!available && (
          <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-muted-foreground text-sm">
            Pay-as-you-go isn't available here yet. The per-execution price and
            the USDC settlement treasury are configured by the platform for this
            environment.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 rounded-xl border border-border/60 bg-sidebar p-4 sm:grid-cols-[auto_1fr]">
          <div className="sm:border-border/60 sm:border-r sm:pr-6">
            <p className="font-semibold text-2xl tracking-tight">
              {priceConfigured ? formatUsdc(status.priceUsdc) : "--"}
            </p>
            <p className="text-muted-foreground text-sm">per extra execution</p>
            <p className="mt-1 text-muted-foreground text-xs">
              beyond {FREE_LIMIT.toLocaleString()} free / month
            </p>
          </div>

          <div className="space-y-2">
            <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              How it compares
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground text-xs">
                    <th className="pr-4 pb-1 font-medium">Option</th>
                    <th className="pr-4 pb-1 font-medium">Monthly</th>
                    <th className="pb-1 font-medium">~ per execution</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-border/40 border-t">
                    <td className="py-1.5 pr-4 font-medium">
                      Pay as you go
                      <span className="text-muted-foreground/70">
                        {" "}
                        ({FREE_LIMIT.toLocaleString()})
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 text-keeperhub-green-dark">
                      $0
                    </td>
                    <td className="py-1.5">
                      {priceConfigured ? formatUsdc(status.priceUsdc) : "--"}
                    </td>
                  </tr>
                  {COMPARISON_PLANS.map(
                    ({ name, included, monthlyPrice, perExecution }) => (
                      <tr className="border-border/40 border-t" key={name}>
                        <td className="py-1.5 pr-4 text-muted-foreground">
                          {name}
                          <span className="text-muted-foreground/70">
                            {" "}
                            ({included.toLocaleString()})
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 text-muted-foreground">
                          ${monthlyPrice}
                        </td>
                        <td className="py-1.5 text-muted-foreground">
                          {formatPerExec(perExecution)}
                          <span className="text-muted-foreground/70">*</span>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground text-xs">
              * Cost per execution for extra executions once the plan's included
              limit is reached.
            </p>
            {breakEvenRuns !== null && (
              <p className="text-muted-foreground text-xs">
                Below about {breakEvenRuns.toLocaleString()} executions/month,
                staying on free with pay-as-you-go costs less than upgrading to
                the cheapest plan.
              </p>
            )}
          </div>
        </div>

        {status.enabled && status.usage && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric
              label="This period"
              value={`${status.usage.periodExecutions} runs`}
            />
            <Metric
              label="Spent this period"
              value={formatUsdc(status.usage.periodSpentUsdc)}
            />
            <Metric
              label="Spent today"
              value={formatUsdc(status.usage.dailySpentUsdc)}
            />
            <Metric
              label="Period"
              value={`${formatDate(status.usage.periodStart)} - ${formatDate(
                status.usage.periodEnd
              )}`}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="payg-daily-cap">Daily spend cap (USDC)</Label>
            <Input
              id="payg-daily-cap"
              inputMode="decimal"
              onChange={(e) => setDailyCap(e.target.value)}
              placeholder="No limit"
              value={dailyCap}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payg-period-cap">Per-period spend cap (USDC)</Label>
            <Input
              id="payg-period-cap"
              inputMode="decimal"
              onChange={(e) => setPeriodCap(e.target.value)}
              placeholder="No limit"
              value={periodCap}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Executions that would exceed a cap are blocked with a clear reason and
          recorded as a billing error on the run. Leave a field empty for no
          limit.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={saving || !available}
            onClick={() => save(!status.enabled)}
            type="button"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {status.enabled ? "Save caps" : "Enable pay-as-you-go"}
          </Button>
          {status.enabled && (
            <Button
              disabled={saving}
              onClick={disable}
              type="button"
              variant="ghost"
            >
              Disable
            </Button>
          )}
        </div>

        {status.enabled && status.history.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <h3 className="font-medium text-sm">Recent charges</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-border/60 border-b text-left text-muted-foreground text-xs">
                      <th className="py-2 pr-4 font-medium">Date</th>
                      <th className="py-2 pr-4 font-medium">Amount</th>
                      <th className="py-2 font-medium">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.history.map((row) => (
                      <tr
                        className="border-border/30 border-b last:border-b-0"
                        key={row.executionId}
                      >
                        <td className="py-2 pr-4 text-muted-foreground">
                          {formatDate(row.createdAt)}
                        </td>
                        <td className="py-2 pr-4">
                          {formatUsdc(row.amountUsdc)}
                        </td>
                        <td className="py-2 font-mono text-muted-foreground text-xs">
                          {row.txHash ? `${row.txHash.slice(0, 10)}...` : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-medium text-sm">{value}</p>
    </div>
  );
}
