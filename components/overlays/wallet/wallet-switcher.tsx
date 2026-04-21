"use client";

import { truncateAddress } from "@/lib/address-utils";
import type { WalletInfo } from "@/lib/wallet/types";

const PROVIDER_DISPLAY_ORDER: Record<"para" | "turnkey", number> = {
  para: 0,
  turnkey: 1,
} as const;

export function WalletSwitcher({
  wallets,
  isAdmin,
  switching,
  onSelect,
}: {
  wallets: WalletInfo[];
  isAdmin: boolean;
  switching: boolean;
  onSelect: (walletId: string) => void;
}): React.ReactElement {
  const ordered = [...wallets].sort(
    (a, b) =>
      PROVIDER_DISPLAY_ORDER[a.provider] - PROVIDER_DISPLAY_ORDER[b.provider]
  );
  const hasPara = ordered.some((w) => w.provider === "para");
  return (
    <section>
      <div className="mb-2 font-medium text-sm">Active wallet for signing</div>
      {hasPara && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-400">
          Para will be deprecated soon. Switch the active wallet to Turnkey and
          move your assets from the Para wallet before the cutover.
        </div>
      )}
      <div className="flex gap-2">
        {ordered.map((wallet) => {
          const label = wallet.provider === "para" ? "Para" : "Turnkey";
          const disabled = !isAdmin || switching || wallet.isActive;
          return (
            <button
              className={`flex-1 rounded-md border px-3 py-2 text-left text-sm transition ${
                wallet.isActive
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-background"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
              disabled={disabled}
              key={wallet.id}
              onClick={() => onSelect(wallet.id)}
              type="button"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{label}</span>
                {wallet.isActive && (
                  <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
                    Active
                  </span>
                )}
              </div>
              <code className="font-mono text-muted-foreground text-xs">
                {truncateAddress(wallet.walletAddress)}
              </code>
            </button>
          );
        })}
      </div>
    </section>
  );
}
