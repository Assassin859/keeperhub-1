"use client";

import { ExternalLink, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";
import type { AssetRow } from "./use-account-assets";

function fmt(balance: string): string {
  const n = Number.parseFloat(balance);
  if (!Number.isFinite(n)) {
    return "0";
  }
  if (n === 0) {
    return "0";
  }
  return n < 0.000_001
    ? "<0.000001"
    : n.toLocaleString(undefined, {
        maximumFractionDigits: 6,
      });
}

export function AssetsTable({
  rows,
  canWithdraw,
  canAdd,
  onAdd,
  onWithdraw,
}: {
  rows: AssetRow[];
  canWithdraw: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Asset</TableHead>
          <TableHead>Network</TableHead>
          <TableHead className="text-right">Balance</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const funded = Number.parseFloat(row.balance) > 0;
          return (
            <TableRow className={SETTINGS_ROW} key={row.key}>
              <TableCell>
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 font-medium">
                    {row.symbol}
                    {row.kind === "native" && (
                      <span className="rounded-full border px-2 py-0.5 text-[0.6875rem]">
                        Native
                      </span>
                    )}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {row.name}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {row.chainName}
                  {row.isTestnet && (
                    <span className="rounded-full border px-2 py-0.5 text-[0.6875rem]">
                      Testnet
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {fmt(row.balance)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  {row.explorerUrl && (
                    <Button
                      aria-label="View on explorer"
                      asChild
                      size="icon"
                      variant="ghost"
                    >
                      <a href={row.explorerUrl} rel="noopener" target="_blank">
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  )}
                  {canWithdraw && funded && (
                    <Button
                      onClick={() => onWithdraw(row.chainId, row.tokenAddress)}
                      size="sm"
                      variant="outline"
                    >
                      <Send className="size-3.5" />
                      Withdraw
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
        {canAdd && (
          <TableRow className={SETTINGS_ROW}>
            <TableCell colSpan={4}>
              <button
                className="flex items-center gap-3 text-left"
                onClick={onAdd}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed">
                  <Plus className="size-4 text-muted-foreground" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">Add a custom token</span>
                  <span className="text-muted-foreground text-xs">
                    Track a token this list does not know about yet.
                  </span>
                </span>
              </button>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
