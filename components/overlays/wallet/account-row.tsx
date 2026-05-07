"use client";

import { ChevronRight, ShieldCheck, Wallet } from "lucide-react";
import { truncateAddress } from "@/lib/address-utils";

export type WalletAccountKind =
  | { kind: "turnkey"; address: string }
  | {
      kind: "safe";
      safeId: string;
      address: string;
      chainId: number;
      chainName: string;
      isSigningActive: boolean;
    };

type AccountRowProps = {
  account: WalletAccountKind;
  /** Native asset balance for the wallet's primary chain (Safe) or "Multi-chain" (Turnkey). */
  subtitle?: string;
  onClick: () => void;
};

export function AccountRow({
  account,
  subtitle,
  onClick,
}: AccountRowProps): React.ReactElement {
  const isTurnkey = account.kind === "turnkey";
  const Icon = isTurnkey ? Wallet : ShieldCheck;

  const title = isTurnkey ? "Turnkey EOA" : `Safe · ${account.chainName}`;
  const addressLine = truncateAddress(account.address);

  return (
    <button
      aria-label={`Open ${title}`}
      className="group flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/40"
      onClick={onClick}
      type="button"
    >
      <div className="rounded-md border bg-muted/30 p-2 text-muted-foreground">
        <Icon aria-hidden="true" className="h-4 w-4" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{title}</span>
          {!isTurnkey && account.isSigningActive && (
            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
              Active signer
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
          <span>{addressLine}</span>
          {subtitle && <span className="font-sans">·</span>}
          {subtitle && <span className="font-sans">{subtitle}</span>}
        </div>
      </div>

      <ChevronRight
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
