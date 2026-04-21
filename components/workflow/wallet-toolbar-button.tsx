"use client";

import { Copy, Plus, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WalletOverlay } from "@/components/overlays/wallet-overlay";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import { useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { useWalletInfo } from "@/lib/wallet/use-wallet-info";

/**
 * Compact toolbar affordance for the organization wallet.
 *
 * - Shows the truncated wallet address when a wallet exists (click opens
 *   the wallet overlay; clipboard copies the full checksummed address).
 * - Shows a "Create wallet" button when the user is signed in but has no
 *   wallet yet (click opens the overlay on the balances tab so admins can
 *   create one).
 * - Renders nothing for anonymous / unverified users to keep the toolbar
 *   clean on first load.
 */
export function WalletToolbarButton(): React.ReactElement | null {
  const { data: session, isPending } = useSession();
  const { open: openOverlay } = useOverlay();
  const { hasWallet, walletAddress, isLoading } = useWalletInfo();

  if (isPending) {
    return null;
  }

  if (!session?.user || isAnonymousUser(session.user)) {
    return null;
  }

  if (session.user.emailVerified !== true) {
    return null;
  }

  if (isLoading && !walletAddress) {
    return null;
  }

  if (!hasWallet || !walletAddress) {
    return (
      <Button
        className="h-9"
        onClick={() => openOverlay(WalletOverlay)}
        size="sm"
        variant="outline"
      >
        <Plus className="size-4" />
        <span className="hidden sm:inline">Create wallet</span>
        <span className="sm:hidden">Wallet</span>
      </Button>
    );
  }

  const handleOpenWallet = (): void => {
    openOverlay(WalletOverlay);
  };

  const handleCopy = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    navigator.clipboard.writeText(toChecksumAddress(walletAddress));
    toast.success("Address copied to clipboard");
  };

  return (
    <div className="flex h-9 items-center rounded-md border bg-secondary text-secondary-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="flex h-full items-center gap-2 rounded-l-md px-3 font-medium text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            data-testid="wallet-toolbar-address"
            onClick={handleOpenWallet}
            type="button"
          >
            <Wallet className="size-4 shrink-0" />
            <span className="font-mono text-xs">
              {truncateAddress(walletAddress)}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Open wallet</TooltipContent>
      </Tooltip>
      <div className="h-5 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Copy wallet address"
            className="flex h-full items-center rounded-r-md px-2 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
            onClick={handleCopy}
            type="button"
          >
            <Copy className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy address</TooltipContent>
      </Tooltip>
    </div>
  );
}
