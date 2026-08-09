"use client";

import { ChevronRight, ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { SafeSigningToggle } from "@/components/safe/safe-signing-toggle";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { truncateAddress } from "@/lib/address-utils";
import { cn } from "@/lib/utils";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";
import { accountSlug, type WalletAccounts } from "@/lib/wallet/use-wallet-accounts";

export function AccountsTable({
  accounts,
  isAdmin,
  onSigningChange,
}: {
  accounts: WalletAccounts;
  isAdmin: boolean;
  onSigningChange: (safeId: string, next: boolean) => void;
}): React.ReactElement {
  const router = useRouter();

  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Account</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>Network</TableHead>
          <TableHead className="text-right">Signing</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.all.map((account) => {
          const isSafe = account.kind === "safe";
          const name = isSafe
            ? "Safe smart account"
            : account.family === "solana"
              ? "Turnkey signer (Solana)"
              : "Turnkey signer (EVM)";
          return (
            <TableRow
              className={cn("cursor-pointer", SETTINGS_ROW)}
              key={accountSlug(account)}
              onClick={() =>
                router.push(`/settings/wallets/${accountSlug(account)}`)
              }
            >
              <TableCell>
                <div className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    {isSafe ? (
                      <ShieldCheck className="size-4" />
                    ) : (
                      <Wallet className="size-4" />
                    )}
                  </span>
                  <span className="font-medium">{name}</span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-muted-foreground text-xs">
                {truncateAddress(account.address)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {isSafe
                  ? account.chainName
                  : account.family === "solana"
                    ? "Solana"
                    : "All EVM networks"}
              </TableCell>
              <TableCell className="text-right">
                <div
                  className="flex items-center justify-end gap-2"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {isSafe ? (
                    <SafeSigningToggle
                      chainLabel={account.chainName}
                      compact
                      isActive={account.isSigningActive}
                      isAdmin={isAdmin}
                      onChange={(next) => onSigningChange(account.safeId, next)}
                      safeId={account.safeId}
                    />
                  ) : (
                    <span className="rounded-full border px-2 py-0.5 text-[0.6875rem]">
                      Default signer
                    </span>
                  )}
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
