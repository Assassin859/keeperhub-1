"use client";

import {
  ChevronDown,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Pager } from "@/components/activity/pager";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toChecksumAddress } from "@/lib/address-utils";
import { BILLING_API } from "@/lib/billing/constants";
import { PLANS } from "@/lib/billing/plans";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { useOrganization } from "@/lib/hooks/use-organization";
import type { PageMeta } from "@/lib/pagination";

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
  const [infoOpen, setInfoOpen] = useState(false);

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
          <button
            aria-label="How pay-as-you-go works and how to fund it"
            className="inline-flex items-center text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={() => setInfoOpen(true)}
            type="button"
          >
            <Info className="size-3.5" />
          </button>
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
              hint="Resets daily at 00:00 UTC"
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

      {status.enabled && <PaygChargesTable key={orgId} />}

      <PaygCapsDialog
        enabling={!status.enabled}
        initialDaily={capToInput(status.caps.dailyUsdc)}
        initialPeriod={capToInput(status.caps.periodUsdc)}
        onConfirm={(daily, period) => saveCaps(daily, period, !status.enabled)}
        onOpenChange={setModalOpen}
        open={modalOpen}
        saving={saving}
      />

      <PaygInfoDialog
        chainId={status.chainId}
        onOpenChange={setInfoOpen}
        open={infoOpen}
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
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        {hint && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={hint}
                  className="inline-flex text-muted-foreground/70 transition-colors hover:text-foreground"
                  type="button"
                >
                  <Info className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{hint}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
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

function PaygInfoDialog({
  open,
  onOpenChange,
  chainId,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  chainId: number;
}): React.ReactElement {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoadingBalance(true);
    async function loadBalances(): Promise<void> {
      try {
        const res = await fetch("/api/user/wallet/balances");
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as {
          walletAddress: string;
          balances: {
            chainId: number;
            supportedTokens: { symbol: string; balance: string }[];
            tokens: { symbol: string; balance: string }[];
          }[];
        };
        if (cancelled) {
          return;
        }
        setWalletAddress(data.walletAddress);
        const chain = data.balances.find((b) => b.chainId === chainId);
        const usdc =
          chain?.supportedTokens.find((t) => t.symbol === "USDC") ??
          chain?.tokens.find((t) => t.symbol === "USDC");
        setUsdcBalance(usdc?.balance ?? "0");
      } finally {
        if (!cancelled) {
          setLoadingBalance(false);
        }
      }
    }
    loadBalances().catch(() => {
      // Balance is best-effort context in this dialog.
    });
    return () => {
      cancelled = true;
    };
  }, [open, chainId]);

  const chainName = chainId === 8453 ? "Base" : `chain ${chainId}`;
  const checksummedAddress = walletAddress
    ? toChecksumAddress(walletAddress)
    : null;
  const explorerAddress =
    chainId === 8453 && checksummedAddress
      ? `https://basescan.org/address/${checksummedAddress}`
      : null;
  let balanceLabel = "Unavailable";
  if (loadingBalance) {
    balanceLabel = "Loading...";
  } else if (usdcBalance !== null) {
    balanceLabel = `${usdcBalance} USDC`;
  }

  async function copyAddress(): Promise<void> {
    if (!checksummedAddress) {
      return;
    }
    await navigator.clipboard.writeText(checksummedAddress);
    toast.success("Address copied");
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>How pay-as-you-go works</DialogTitle>
          <DialogDescription>
            Extra executions are paid in USDC from your organization wallet,
            settled on-chain and gasless. Fund the wallet below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
            <p className="text-muted-foreground text-xs">
              Funding wallet ({chainName})
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background/60 px-2 py-1 font-mono text-xs">
                {checksummedAddress ?? "Loading..."}
              </code>
              <Button
                disabled={!checksummedAddress}
                onClick={() => {
                  copyAddress().catch(() => undefined);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Copy
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              USDC balance:{" "}
              <span className="font-medium text-foreground">
                {balanceLabel}
              </span>
            </p>
          </div>
          <div className="space-y-1.5 text-muted-foreground text-xs">
            <p>
              To top up, send{" "}
              <span className="font-medium text-foreground">
                USDC on {chainName}
              </span>{" "}
              to the address above.
            </p>
            {explorerAddress && (
              <a
                className="text-keeperhub-green-dark hover:underline"
                href={explorerAddress}
                rel="noopener"
                target="_blank"
              >
                View wallet on explorer
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PaygCharge = {
  executionId: string;
  workflowId: string | null;
  workflowName: string | null;
  amountUsdc: string;
  txHash: string | null;
  txUrl: string | null;
  chainId: number;
  createdAt: string;
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Server-side paginated charge history. Re-mounted (via key) on org switch so
 * paging resets to the first page for the new org.
 */
function PaygChargesTable(): React.ReactElement | null {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim(), 300);
  const [items, setItems] = useState<PaygCharge[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Abort any in-flight request when the page or search changes, so only the
    // latest request resolves rather than several piling up as the user types.
    const controller = new AbortController();
    setLoading(true);
    async function load(): Promise<void> {
      const params = new URLSearchParams({ page: String(page), limit: "10" });
      if (debouncedSearch) {
        params.set("q", debouncedSearch);
      }
      try {
        const res = await fetch(
          `${BILLING_API.PAYG}/charges?${params.toString()}`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as {
          items: PaygCharge[];
          meta: PageMeta;
        };
        setItems(data.items);
        setMeta(data.meta);
      } catch {
        // Superseded by a newer request (aborted) or a transient network error.
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }
    load().catch(() => undefined);
    return () => controller.abort();
  }, [page, debouncedSearch]);

  // Hide the section only when the org has no charges and isn't searching.
  if (!meta || (meta.total === 0 && !debouncedSearch)) {
    return null;
  }

  const skeletonCount = items.length > 0 ? items.length : 5;

  return (
    <>
      <Separator />
      <div className="space-y-2">
        <button
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <h4 className="font-medium text-sm">Recent charges</h4>
          <span className="flex items-center gap-2 text-muted-foreground text-xs">
            {meta.total} {meta.total === 1 ? "charge" : "charges"}
            <ChevronDown
              className={`size-4 transition-transform duration-200 ${
                open ? "rotate-180" : ""
              }`}
            />
          </span>
        </button>
        {open && (
          <>
            <div className="flex justify-end">
              <Input
                className="h-8 w-full max-w-56"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search workflow, execution, or tx"
                value={search}
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-border/60 border-b text-left text-muted-foreground text-xs">
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Workflow</th>
                    <th className="py-2 pr-4 font-medium">Execution</th>
                    <th className="py-2 pr-4 font-medium">Amount</th>
                    <th className="py-2 font-medium">Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {loading &&
                    Array.from({ length: skeletonCount }, (_, index) => (
                      <tr
                        className="border-border/30 border-b last:border-b-0"
                        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
                        key={`skeleton-${index}`}
                      >
                        <td className="py-2 pr-4">
                          <Skeleton className="h-4 w-28" />
                        </td>
                        <td className="py-2 pr-4">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="py-2 pr-4">
                          <Skeleton className="h-4 w-20" />
                        </td>
                        <td className="py-2 pr-4">
                          <Skeleton className="h-4 w-10" />
                        </td>
                        <td className="py-2">
                          <Skeleton className="h-4 w-24" />
                        </td>
                      </tr>
                    ))}
                  {!loading && items.length === 0 && (
                    <tr>
                      <td
                        className="py-4 text-muted-foreground text-xs"
                        colSpan={5}
                      >
                        No charges match your search.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    items.map((row) => (
                      <tr
                        className="border-border/30 border-b last:border-b-0"
                        key={row.executionId}
                      >
                        <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                          {formatDateTime(row.createdAt)}
                        </td>
                        <td className="py-2 pr-4">
                          {row.workflowId && row.workflowName ? (
                            <Link
                              className="text-keeperhub-green-dark hover:underline"
                              href={`/workflows/${row.workflowId}`}
                            >
                              {row.workflowName}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <TruncatedCopy
                            label="Execution ID"
                            value={row.executionId}
                          />
                        </td>
                        <td className="py-2 pr-4">
                          {formatUsdc(row.amountUsdc)}
                        </td>
                        <td className="py-2">
                          <ChargeTx txHash={row.txHash} txUrl={row.txUrl} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Pager meta={meta} onPage={setPage} unit="charges" />
          </>
        )}
      </div>
    </>
  );
}

function TruncatedCopy({
  value,
  label,
}: {
  value: string;
  label: string;
}): React.ReactElement {
  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  }
  return (
    <span className="flex items-center gap-1 font-mono text-muted-foreground text-xs">
      {`${value.slice(0, 10)}...`}
      <button
        aria-label={`Copy ${label.toLowerCase()}`}
        className="text-muted-foreground/70 transition-colors hover:text-foreground"
        onClick={() => {
          copy().catch(() => undefined);
        }}
        type="button"
      >
        <Copy className="size-3.5" />
      </button>
    </span>
  );
}

function ChargeTx({
  txHash,
  txUrl,
}: {
  txHash: string | null;
  txUrl: string | null;
}): React.ReactElement {
  if (!txHash) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <div className="flex items-center gap-1.5">
      <TruncatedCopy label="Transaction hash" value={txHash} />
      {txUrl && (
        <a
          aria-label="View transaction on block explorer"
          className="text-muted-foreground/70 transition-colors hover:text-foreground"
          href={txUrl}
          rel="noopener"
          target="_blank"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}
