"use client";

import { Loader2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const FREE_LIMIT = PLANS.free.features.maxExecutionsPerMonth;

function formatUsdc(decimal: string): string {
  return `$${Number(decimal).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })}`;
}

/** Blank a "0" cap for the input; anything else round-trips as-is. */
function capToInput(decimal: string): string {
  return Number(decimal) === 0 ? "" : decimal;
}

/** A "0" cap reads as no limit; anything else shows the USDC value. */
function capDisplay(decimal: string): string {
  return Number(decimal) === 0 ? "No limit" : formatUsdc(decimal);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Pay-as-you-go controls for a free org, rendered inside the Current Plan card.
 * Caps show as read-only labels; enabling and editing them happen in a modal.
 */
export function PaygSection(): React.ReactElement | null {
  const { organization } = useOrganization();
  const orgId = organization?.id;

  const [status, setStatus] = useState<PaygStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

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
      setStatus((await res.json()) as PaygStatus);
    } catch (error) {
      console.error("[PaygSection] Failed to load status:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: orgId re-triggers on org switch
  useEffect(() => {
    load().catch(() => undefined);
  }, [load, orgId]);

  async function saveCaps(
    dailyCap: string,
    periodCap: string,
    enabling: boolean
  ): Promise<void> {
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
      setModalOpen(false);
      toast.success(enabling ? "Pay-as-you-go enabled" : "Spending caps saved");
    } catch (error) {
      console.error("[PaygSection] Save failed:", error);
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
      console.error("[PaygSection] Disable failed:", error);
      toast.error("Could not disable pay-as-you-go");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 border-border/40 border-t pt-4 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading pay-as-you-go...
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const priceConfigured = Number(status.priceUsdc) > 0;
  const available = status.treasuryConfigured && priceConfigured;

  return (
    <div className="space-y-3 border-border/40 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-keeperhub-green-dark" />
          <span className="font-medium text-sm">Pay as you go</span>
          {status.enabled && (
            <Badge className="border border-keeperhub-green-dark/20 bg-keeperhub-green-dark/10 text-keeperhub-green-dark">
              Active
            </Badge>
          )}
        </div>
        {status.enabled ? (
          <Button
            disabled={saving}
            onClick={disable}
            size="sm"
            type="button"
            variant="ghost"
          >
            Disable
          </Button>
        ) : (
          <Button
            disabled={saving || !available}
            onClick={() => setModalOpen(true)}
            size="sm"
            type="button"
          >
            Enable pay-as-you-go
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        {priceConfigured ? formatUsdc(status.priceUsdc) : "--"} per extra
        execution beyond {FREE_LIMIT.toLocaleString()} free / month, charged in
        USDC from your organization wallet.
      </p>

      {!available && (
        <p className="text-muted-foreground text-xs">
          Pay-as-you-go isn't available in this environment yet.
        </p>
      )}

      {status.enabled && status.usage && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

      {status.enabled && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <CapLabel
              label="Daily spend cap"
              value={capDisplay(status.caps.dailyUsdc)}
            />
            <CapLabel
              label="Per-period spend cap"
              value={capDisplay(status.caps.periodUsdc)}
            />
          </div>
          <Button
            disabled={saving}
            onClick={() => setModalOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Edit caps
          </Button>
        </div>
      )}

      {status.enabled && status.history.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Recent charges</h4>
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

      <PaygCapsDialog
        enabling={!status.enabled}
        initialDaily={capToInput(status.caps.dailyUsdc)}
        initialPeriod={capToInput(status.caps.periodUsdc)}
        onConfirm={(daily, period) => saveCaps(daily, period, !status.enabled)}
        onOpenChange={setModalOpen}
        open={modalOpen}
        saving={saving}
      />
    </div>
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

function CapLabel({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-medium text-sm">{value}</p>
    </div>
  );
}

function PaygCapsDialog({
  open,
  onOpenChange,
  enabling,
  initialDaily,
  initialPeriod,
  saving,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  enabling: boolean;
  initialDaily: string;
  initialPeriod: string;
  saving: boolean;
  onConfirm: (daily: string, period: string) => void;
}): React.ReactElement {
  const [daily, setDaily] = useState(initialDaily);
  const [period, setPeriod] = useState(initialPeriod);

  useEffect(() => {
    if (open) {
      setDaily(initialDaily);
      setPeriod(initialPeriod);
    }
  }, [open, initialDaily, initialPeriod]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {enabling ? "Enable pay-as-you-go" : "Edit spend caps"}
          </DialogTitle>
          <DialogDescription>
            Set optional USDC spend caps. Executions that would exceed a cap are
            blocked with a clear reason and recorded as a billing error on the
            run. Leave a field empty for no limit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="payg-daily-cap">Daily spend cap (USDC)</Label>
            <Input
              id="payg-daily-cap"
              inputMode="decimal"
              onChange={(e) => setDaily(e.target.value)}
              placeholder="No limit"
              value={daily}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payg-period-cap">Per-period spend cap (USDC)</Label>
            <Input
              id="payg-period-cap"
              inputMode="decimal"
              onChange={(e) => setPeriod(e.target.value)}
              placeholder="No limit"
              value={period}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => onConfirm(daily, period)}
            type="button"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {enabling ? "Enable" : "Save caps"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
