"use client";

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BILLING_API } from "@/lib/billing/constants";
import { cn } from "@/lib/utils";

type ChainSponsorship = {
  chainId: number;
  name: string;
  isTestnet: boolean;
  sponsoredWei: string;
  sponsoredMicroUsd: string;
  txCount: number;
};

type MonthlySponsorship = {
  monthStart: string;
  totalMicroUsd: string;
  byChain: ChainSponsorship[];
};

type HistoryResponse = { months: MonthlySponsorship[] };

function formatMicroUsd(microUsd: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(microUsd) / 1_000_000);
}

function formatNativeGas(wei: string): string {
  const value = Number(wei) / 1e18;
  if (value === 0) {
    return "0";
  }
  return value.toFixed(6);
}

function formatMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/**
 * Collapsible monthly sponsorship digest, embedded inside the gas-credits card.
 * The card already shows current-month used/total; this dropdown adds the
 * per-month, per-network breakdown that survives past month-end.
 */
export function GasSponsorshipHistory(): React.ReactElement | null {
  const [months, setMonths] = useState<MonthlySponsorship[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  const [includeTestnets, setIncludeTestnets] = useState(false);

  const fetchHistory = useCallback(async (testnets: boolean): Promise<void> => {
    const params = new URLSearchParams();
    if (testnets) {
      params.set("includeTestnets", "true");
    }
    const query = params.toString();
    const response = await fetch(
      `${BILLING_API.GAS_SPONSORSHIP}${query ? `?${query}` : ""}`
    );
    if (response.status === 404) {
      setAvailable(false);
      return;
    }
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as HistoryResponse;
    setMonths(data.months);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        await fetchHistory(includeTestnets);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load().catch(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchHistory, includeTestnets]);

  if (!available || loading) {
    return null;
  }

  return (
    <Collapsible
      className="rounded-md border border-border/60 bg-muted/30"
      onOpenChange={setOpen}
      open={open}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <CollapsibleTrigger asChild>
          <button
            className="flex flex-1 items-center gap-2 text-left text-muted-foreground text-sm transition-colors hover:text-foreground"
            type="button"
          >
            <ChevronDown
              className={cn(
                "size-4 shrink-0 transition-transform",
                open && "rotate-180"
              )}
            />
            Monthly history
          </button>
        </CollapsibleTrigger>
        <div className="flex items-center gap-2">
          <Switch
            checked={includeTestnets}
            id="show-testnets"
            onCheckedChange={setIncludeTestnets}
          />
          <Label
            className="text-muted-foreground text-xs"
            htmlFor="show-testnets"
          >
            Show testnets
          </Label>
        </div>
      </div>
      <CollapsibleContent>
        <div className="space-y-6 px-3 pt-1 pb-3">
          {months.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No gas has been sponsored yet.
            </p>
          ) : (
            months.map((month) => (
              <div className="space-y-2" key={month.monthStart}>
                <div className="flex items-baseline justify-between">
                  <h4 className="font-medium text-sm">
                    {formatMonth(month.monthStart)}
                  </h4>
                  <span className="font-medium text-sm">
                    {formatMicroUsd(month.totalMicroUsd)}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Network</TableHead>
                      <TableHead className="text-right">Transactions</TableHead>
                      <TableHead className="text-right">Gas (native)</TableHead>
                      <TableHead className="text-right">USD</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {month.byChain.map((chain) => (
                      <TableRow key={`${month.monthStart}-${chain.chainId}`}>
                        <TableCell className="whitespace-nowrap">
                          {chain.name}
                          {chain.isTestnet ? (
                            <span className="ml-2 text-muted-foreground text-xs">
                              testnet
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          {chain.txCount.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNativeGas(chain.sponsoredWei)}
                        </TableCell>
                        <TableCell className="text-right">
                          {chain.isTestnet
                            ? "--"
                            : formatMicroUsd(chain.sponsoredMicroUsd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
