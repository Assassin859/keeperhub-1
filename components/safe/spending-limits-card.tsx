"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { truncateAddress } from "@/lib/address-utils";

type LimitSummary = {
  id: string;
  delegateAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountWei: string;
  spentWei: string;
  periodMinutes: number;
  resetAt: string | null;
  lastTxHash: string | null;
  lastUpdatedAt: string | null;
  createdAt: string;
};

type ListResponse = {
  moduleInstalled: boolean;
  moduleAddress: string | null;
  limits: LimitSummary[];
};

type CommonToken = {
  address: string;
  symbol: string;
  decimals: number;
};

const COMMON_TOKENS: Record<number, CommonToken[]> = {
  1: [
    {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
    },
    {
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI",
      decimals: 18,
    },
  ],
  10: [
    {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      symbol: "USDT",
      decimals: 6,
    },
  ],
  8453: [
    {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      symbol: "DAI",
      decimals: 18,
    },
  ],
  42161: [
    {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      symbol: "USDT",
      decimals: 6,
    },
  ],
};

const PERIOD_PRESETS = [
  { label: "Daily", minutes: 1440 },
  { label: "Weekly", minutes: 10_080 },
  { label: "Monthly", minutes: 43_200 },
] as const;

const TRAILING_ZEROS_RE = /0+$/;
const LEADING_ZEROS_RE = /^0+(?=\d)/;

function minutesToLabel(minutes: number): string {
  const preset = PERIOD_PRESETS.find((p) => p.minutes === minutes);
  if (preset) {
    return preset.label.toLowerCase();
  }
  return `${minutes} min`;
}

function formatAmount(amountWei: string, decimals: number): string {
  try {
    const amount = BigInt(amountWei);
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = amount / divisor;
    const remainder = amount % divisor;
    if (remainder === BigInt(0)) {
      return whole.toString();
    }
    const fraction = remainder.toString().padStart(decimals, "0").slice(0, 4);
    const trimmed = fraction.replace(TRAILING_ZEROS_RE, "");
    return trimmed ? `${whole.toString()}.${trimmed}` : whole.toString();
  } catch {
    return amountWei;
  }
}

function formatResetAt(resetAt: string | null): string {
  if (!resetAt) {
    return "no reset";
  }
  const target = new Date(resetAt).getTime();
  const now = Date.now();
  const diffMs = target - now;
  if (diffMs <= 0) {
    return "resets now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `resets in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `resets in ${days}d`;
}

function humanToWei(value: string, decimals: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = `${whole}${paddedFraction}`.replace(LEADING_ZEROS_RE, "");
  return BigInt(combined || "0");
}

export function SpendingLimitsCard({
  safeId,
  chainId,
  isAdmin,
}: {
  safeId: string;
  chainId: number;
  isAdmin: boolean;
}): React.ReactElement {
  const [loading, setLoading] = useState<boolean>(true);
  const [moduleInstalled, setModuleInstalled] = useState<boolean>(false);
  const [installing, setInstalling] = useState<boolean>(false);
  const [limits, setLimits] = useState<LimitSummary[]>([]);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string>("");
  const [amountInput, setAmountInput] = useState<string>("");
  const [periodMinutes, setPeriodMinutes] = useState<number>(1440);

  const loadLimits = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/allowances`);
      if (!res.ok) {
        toast.error("Failed to load spending limits");
        return;
      }
      const data = (await res.json()) as ListResponse;
      setModuleInstalled(data.moduleInstalled);
      setLimits(data.limits);
    } catch {
      toast.error("Failed to load spending limits");
    } finally {
      setLoading(false);
    }
  }, [safeId]);

  useEffect(() => {
    loadLimits().catch(() => {
      // Toast already fired inside loadLimits.
    });
  }, [loadLimits]);

  const handleInstall = async (): Promise<void> => {
    setInstalling(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/modules/allowance`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        success?: boolean;
        alreadyInstalled?: boolean;
        error?: string;
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Failed to enable spending limits");
        return;
      }
      toast.success(
        data.alreadyInstalled
          ? "Spending limits already enabled"
          : "Spending limits enabled"
      );
      await loadLimits();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to enable module"
      );
    } finally {
      setInstalling(false);
    }
  };

  const tokenCatalog = COMMON_TOKENS[chainId] ?? [];
  const selectedToken = tokenCatalog.find(
    (t) => t.address === selectedTokenAddress
  );

  const resetDialog = (): void => {
    setSelectedTokenAddress("");
    setAmountInput("");
    setPeriodMinutes(1440);
    setDialogMode("create");
  };

  const openCreateDialog = (): void => {
    resetDialog();
    setDialogOpen(true);
  };

  const openEditDialog = (limit: LimitSummary): void => {
    setDialogMode("edit");
    setSelectedTokenAddress(limit.tokenAddress);
    const whole = BigInt(limit.amountWei);
    const divisor = BigInt(10) ** BigInt(limit.tokenDecimals);
    const w = whole / divisor;
    const r = whole % divisor;
    if (r === BigInt(0)) {
      setAmountInput(w.toString());
    } else {
      const frac = r.toString().padStart(limit.tokenDecimals, "0");
      setAmountInput(`${w.toString()}.${frac.replace(TRAILING_ZEROS_RE, "")}`);
    }
    setPeriodMinutes(limit.periodMinutes);
    setDialogOpen(true);
  };

  const handleAddLimit = async (): Promise<void> => {
    if (!selectedToken) {
      toast.error("Select a token");
      return;
    }
    const trimmed = amountInput.trim();
    if (!trimmed || Number.parseFloat(trimmed) <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = humanToWei(trimmed, selectedToken.decimals);
    } catch {
      toast.error("Invalid amount");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/user/safe/${safeId}/allowances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenAddress: selectedToken.address,
          amountWei: amountWei.toString(),
          periodMinutes,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Failed to set limit");
        return;
      }
      toast.success(
        dialogMode === "edit"
          ? `Updated ${selectedToken.symbol} limit`
          : `Limit set for ${selectedToken.symbol}`
      );
      setDialogOpen(false);
      resetDialog();
      await loadLimits();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to set limit"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (tokenAddress: string): Promise<void> => {
    setRevokingToken(tokenAddress);
    try {
      const res = await fetch(
        `/api/user/safe/${safeId}/allowances/${tokenAddress}`,
        { method: "DELETE" }
      );
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
      };
      if (!(res.ok && data.success)) {
        toast.error(data.error ?? "Failed to revoke limit");
        return;
      }
      toast.success("Limit revoked");
      await loadLimits();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to revoke limit"
      );
    } finally {
      setRevokingToken(null);
    }
  };

  if (loading) {
    return (
      <div className="mt-3 flex items-center justify-center rounded-md border bg-muted/20 py-3">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  if (!moduleInstalled) {
    if (!isAdmin) {
      return (
        <div className="mt-3 rounded-md border bg-muted/20 p-3 text-muted-foreground text-xs">
          Spending limits are not enabled. Ask an admin to enable them.
        </div>
      );
    }
    return (
      <div className="mt-3 rounded-md border bg-muted/20 p-3">
        <p className="mb-2 text-muted-foreground text-xs">
          Enable Safe's Allowance Module to set per-token spending limits.
          Limits appear natively on app.safe.global.
        </p>
        <Button
          disabled={installing}
          onClick={handleInstall}
          size="sm"
          type="button"
        >
          {installing ? (
            <Spinner className="h-4 w-4" />
          ) : (
            "Enable spending limits"
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-xs">Spending limits</span>
        {isAdmin && (
          <Button
            onClick={openCreateDialog}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>
        )}
      </div>

      {limits.length === 0 && (
        <p className="text-muted-foreground text-xs">
          No limits set. Add one to cap outbound spending per token.
        </p>
      )}

      {limits.length > 0 && (
        <ul className="space-y-1">
          {limits.map((limit) => (
            <li
              className="flex items-center justify-between rounded-sm bg-background px-2 py-1.5 text-xs"
              key={limit.id}
            >
              <div className="flex flex-col">
                <span className="font-medium">
                  {formatAmount(limit.spentWei, limit.tokenDecimals)} /{" "}
                  {formatAmount(limit.amountWei, limit.tokenDecimals)}{" "}
                  {limit.tokenSymbol}
                </span>
                <span className="text-muted-foreground">
                  {minutesToLabel(limit.periodMinutes)} -{" "}
                  {formatResetAt(limit.resetAt)} -{" "}
                  {truncateAddress(limit.tokenAddress)}
                </span>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1">
                  <Button
                    onClick={() => openEditDialog(limit)}
                    size="icon"
                    title="Edit limit"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    disabled={revokingToken === limit.tokenAddress}
                    onClick={() => handleRevoke(limit.tokenAddress)}
                    size="icon"
                    title="Revoke limit"
                    type="button"
                    variant="ghost"
                  >
                    {revokingToken === limit.tokenAddress ? (
                      <Spinner className="h-3 w-3" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            resetDialog();
          }
        }}
        open={dialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "edit"
                ? "Edit spending limit"
                : "Add spending limit"}
            </DialogTitle>
            <DialogDescription>
              Caps how much of this token the Safe can release per period.
              Enforced on-chain by the Safe Allowance Module. Editing replaces
              the existing on-chain allowance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="safe-limit-token">
                Token
              </Label>
              <Select
                disabled={submitting || dialogMode === "edit"}
                onValueChange={setSelectedTokenAddress}
                value={selectedTokenAddress}
              >
                <SelectTrigger id="safe-limit-token">
                  <SelectValue placeholder="Select a token" />
                </SelectTrigger>
                <SelectContent>
                  {tokenCatalog.map((token) => (
                    <SelectItem key={token.address} value={token.address}>
                      {token.symbol} - {truncateAddress(token.address)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="safe-limit-amount">
                Amount{selectedToken ? ` (${selectedToken.symbol})` : ""}
              </Label>
              <Input
                disabled={submitting || !selectedToken}
                id="safe-limit-amount"
                inputMode="decimal"
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="100"
                value={amountInput}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="safe-limit-period">
                Period
              </Label>
              <Select
                disabled={submitting}
                onValueChange={(v) => setPeriodMinutes(Number.parseInt(v, 10))}
                value={periodMinutes.toString()}
              >
                <SelectTrigger id="safe-limit-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_PRESETS.map((preset) => (
                    <SelectItem
                      key={preset.minutes}
                      value={preset.minutes.toString()}
                    >
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={submitting}
              onClick={() => setDialogOpen(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={submitting || !selectedToken || !amountInput}
              onClick={handleAddLimit}
              type="button"
            >
              {submitting && <Spinner className="h-4 w-4" />}
              {!submitting &&
                (dialogMode === "edit" ? "Save changes" : "Add limit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
