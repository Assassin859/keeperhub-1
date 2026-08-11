"use client";

import { ChevronRight, Plus, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  accountSlug,
  type WalletAccounts,
} from "@/lib/wallet/use-wallet-accounts";
import { cn } from "@/lib/utils";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSettingsContext } from "../settings-context";
import { AccountAddress } from "./account-address";

export function AccountsTable({
  accounts,
  canManage,
  onAddSafe,
  onFindExisting,
  finding,
}: {
  accounts: WalletAccounts;
  canManage: boolean;
  onAddSafe: () => void;
  /** Looks on chain for Safes already deployed at this org's address. */
  onFindExisting: () => void;
  finding: boolean;
}): React.ReactElement {
  const router = useRouter();
  const { organizationId } = useSettingsContext();

  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Account</TableHead>
          <TableHead>Network</TableHead>
          <TableHead className="w-8" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.all.map((account) => {
          const isSafe = account.kind === "safe";
          const isSolana = !isSafe && account.family === "solana";
          const name = isSafe
            ? `Safe on ${account.chainName}`
            : isSolana
              ? "Turnkey signer (Solana)"
              : "Turnkey signer (EVM)";
          return (
            <TableRow
              className={cn("group cursor-pointer", SETTINGS_ROW)}
              key={accountSlug(account)}
              onClick={() =>
                router.push(
                  `/settings/${organizationId}/wallets/${accountSlug(account)}`
                )
              }
            >
              <TableCell>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    {isSafe ? (
                      <ShieldCheck className="size-4" />
                    ) : (
                      <Wallet className="size-4" />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{name}</span>
                    <AccountAddress
                      address={account.address}
                      chainId={isSafe ? account.chainId : undefined}
                      isEvm={!isSolana}
                    />
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {isSafe
                  ? account.chainName
                  : isSolana
                    ? "Solana"
                    : "All EVM networks"}
              </TableCell>
              <TableCell className="text-right">
                <ChevronRight className="size-4 text-muted-foreground" />
              </TableCell>
            </TableRow>
          );
        })}
        {canManage && (
          // Adding an account belongs with the accounts, not in the card's
          // header: the header buttons named Safe operations rather than the
          // thing the user is after, which is another wallet.
          <TableRow className={cn("group", SETTINGS_ROW)}>
            <TableCell colSpan={2}>
              <button
                className="flex items-center gap-3 text-left"
                onClick={onAddSafe}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed">
                  <Plus className="size-4 text-muted-foreground" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">Add a Safe account</span>
                  <span className="text-muted-foreground text-xs">
                    A smart account that holds funds and signs on one network.
                  </span>
                </span>
              </button>
            </TableCell>
            <TableCell className="text-right">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    disabled={finding}
                    onClick={onFindExisting}
                    size="sm"
                    variant="ghost"
                  >
                    <RefreshCw
                      className={cn("size-3.5", finding && "animate-spin")}
                    />
                    Find existing
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Looks on chain for Safes already deployed at this
                  organization's address but not listed here.
                </TooltipContent>
              </Tooltip>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
