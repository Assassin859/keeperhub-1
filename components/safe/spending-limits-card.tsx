"use client";

import { Copy, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getExplorerAddressUrl } from "@/components/safe/chain-prefixes";
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
    {
      address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
      symbol: "USDS",
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
    {
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      symbol: "DAI",
      decimals: 18,
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
    {
      address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
      symbol: "USDS",
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
  56: [
    {
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      symbol: "USDC",
      decimals: 18,
    },
    {
      address: "0x55d398326f99059fF775485246999027B3197955",
      symbol: "USDT",
      decimals: 18,
    },
  ],
  137: [
    {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      symbol: "USDT",
      decimals: 6,
    },
  ],
  43114: [
    {
      address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
      symbol: "USDT",
      decimals: 6,
    },
  ],
  11155111: [
    {
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      symbol: "USDC",
      decimals: 6,
    },
  ],
  11155420: [
    {
      address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
      symbol: "USDC",
      decimals: 6,
    },
  ],
  84532: [
    {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      symbol: "USDC",
      decimals: 6,
    },
  ],
  421614: [
    {
      address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      symbol: "USDC",
      decimals: 6,
    },
  ],
  97: [],
  80002: [],
  43113: [],
};

const PERIOD_PRESETS = [
  { label: "Daily", minutes: 1440 },
  { label: "Weekly", minutes: 10_080 },
  { label: "Monthly", minutes: 43_200 },
] as const;

const CUSTOM_TOKEN_SENTINEL = "__custom__" as const;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const TRAILING_ZEROS_RE = /0+$/;
const LEADING_ZEROS_RE = /^0+(?=\d)/;

function minutesToLabel(minutes: number): string {
  const preset = PERIOD_PRESETS.find((p) => p.minutes === minutes);
  if (preset) {
    return preset.label;
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
  const [customAddress, setCustomAddress] = useState<string>("");
  const [customSymbol, setCustomSymbol] = useState<string>("");
  const [customDecimals, setCustomDecimals] = useState<string>("18");

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
  // In "create" mode, a token that already has a limit should NOT appear
  // in the picker -- the Allowance Module stores one row per (delegate,
  // token), so selecting an already-limited token silently replaces the
  // existing limit. Users who want to change an existing limit use the
  // Edit (pencil) icon instead. Edit mode still shows the row's token so
  // the Select renders the current selection.
  const limitedAddresses = new Set(
    limits.map((l) => l.tokenAddress.toLowerCase())
  );
  const availableTokens =
    dialogMode === "edit"
      ? tokenCatalog
      : tokenCatalog.filter(
          (t) => !limitedAddresses.has(t.address.toLowerCase())
        );
  const isCustomMode = selectedTokenAddress === CUSTOM_TOKEN_SENTINEL;
  const customDecimalsParsed = Number.parseInt(customDecimals, 10);
  const customToken: CommonToken | undefined = isCustomMode
    ? {
        address: customAddress,
        symbol: customSymbol || "CUSTOM",
        decimals: Number.isFinite(customDecimalsParsed)
          ? customDecimalsParsed
          : 18,
      }
    : undefined;
  const catalogToken = tokenCatalog.find(
    (t) => t.address.toLowerCase() === selectedTokenAddress.toLowerCase()
  );
  const selectedToken = customToken ?? catalogToken;

  const resetDialog = (): void => {
    setSelectedTokenAddress("");
    setAmountInput("");
    setPeriodMinutes(1440);
    setDialogMode("create");
    setCustomAddress("");
    setCustomSymbol("");
    setCustomDecimals("18");
  };

  const openCreateDialog = (): void => {
    resetDialog();
    setDialogOpen(true);
  };

  const openEditDialog = (limit: LimitSummary): void => {
    setDialogMode("edit");
    // Match case against the catalog so the <Select /> renders the right
    // item; DB stores lowercase addresses while the catalog uses EIP-55
    // checksummed ones.
    const catalogMatch = tokenCatalog.find(
      (t) => t.address.toLowerCase() === limit.tokenAddress.toLowerCase()
    );
    setSelectedTokenAddress(catalogMatch?.address ?? limit.tokenAddress);
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
    if (isCustomMode) {
      if (!ADDRESS_RE.test(customAddress)) {
        toast.error("Enter a valid 0x token address");
        return;
      }
      if (!customSymbol.trim()) {
        toast.error("Enter a symbol for the custom token");
        return;
      }
      if (
        !Number.isFinite(customDecimalsParsed) ||
        customDecimalsParsed < 0 ||
        customDecimalsParsed > 36
      ) {
        toast.error("Decimals must be between 0 and 36");
        return;
      }
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
          // Only forwarded for custom tokens; server ignores for known ones
          ...(isCustomMode && {
            tokenSymbol: selectedToken.symbol,
            tokenDecimals: selectedToken.decimals,
          }),
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
          Install Safe's Allowance Module to set per-token spending caps.
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
          {limits.map((limit) => {
            const explorerUrl = getExplorerAddressUrl(
              chainId,
              limit.tokenAddress
            );
            const handleCopy = (): void => {
              navigator.clipboard.writeText(limit.tokenAddress);
              toast.success("Token address copied");
            };
            return (
              <li
                className="flex items-start justify-between gap-3 rounded-md bg-background px-3 py-2 text-xs"
                key={limit.id}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-medium text-sm">
                    {formatAmount(limit.spentWei, limit.tokenDecimals)} /{" "}
                    {formatAmount(limit.amountWei, limit.tokenDecimals)}{" "}
                    {limit.tokenSymbol}
                  </span>
                  <span className="text-muted-foreground">
                    {minutesToLabel(limit.periodMinutes)} -{" "}
                    {formatResetAt(limit.resetAt)}
                  </span>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <code className="font-mono">
                      {truncateAddress(limit.tokenAddress)}
                    </code>
                    <button
                      aria-label="Copy token address"
                      className="hover:text-foreground"
                      onClick={handleCopy}
                      type="button"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                    {explorerUrl && (
                      <a
                        aria-label="View token on explorer"
                        className="hover:text-foreground"
                        href={explorerUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 items-center gap-1">
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
            );
          })}
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
                <SelectContent align="start">
                  {availableTokens.map((token) => (
                    <SelectItem key={token.address} value={token.address}>
                      {token.symbol} - {truncateAddress(token.address)}
                    </SelectItem>
                  ))}
                  {dialogMode === "create" && (
                    <SelectItem value={CUSTOM_TOKEN_SENTINEL}>
                      Custom token...
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            {isCustomMode && (
              <div className="space-y-2 rounded-md border bg-muted/20 p-2">
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="safe-limit-custom-addr">
                    Token address
                  </Label>
                  <Input
                    disabled={submitting}
                    id="safe-limit-custom-addr"
                    onChange={(e) => setCustomAddress(e.target.value.trim())}
                    placeholder="0x..."
                    value={customAddress}
                  />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1 space-y-1">
                    <Label
                      className="text-xs"
                      htmlFor="safe-limit-custom-symbol"
                    >
                      Symbol
                    </Label>
                    <Input
                      disabled={submitting}
                      id="safe-limit-custom-symbol"
                      onChange={(e) => setCustomSymbol(e.target.value)}
                      placeholder="TKN"
                      value={customSymbol}
                    />
                  </div>
                  <div className="w-24 space-y-1">
                    <Label
                      className="text-xs"
                      htmlFor="safe-limit-custom-decimals"
                    >
                      Decimals
                    </Label>
                    <Input
                      disabled={submitting}
                      id="safe-limit-custom-decimals"
                      inputMode="numeric"
                      onChange={(e) => setCustomDecimals(e.target.value)}
                      placeholder="18"
                      value={customDecimals}
                    />
                  </div>
                </div>
              </div>
            )}
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
                <SelectContent align="start">
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
