"use client";

import { ArrowRight, ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectAuthPanel } from "@/components/auth/connect-auth-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { useInjectedWallets } from "@/lib/hooks/use-injected-wallets";
import type { DiscoveredWallet, WalletBrand } from "@/lib/wallet/connect-types";
import { loginWithWallet } from "@/lib/wallet/wallet-login";

const POPULAR_WALLETS: WalletBrand[] = [
  {
    rdns: "io.metamask",
    name: "MetaMask",
    installUrl: "https://metamask.io/download/",
    icon: "/wallets/metamask.svg",
  },
  {
    rdns: "io.rabby",
    name: "Rabby",
    installUrl: "https://rabby.io/",
    icon: "/wallets/rabby.png",
  },
  {
    rdns: "com.coinbase.wallet",
    name: "Coinbase Wallet",
    installUrl: "https://www.coinbase.com/wallet/downloads",
    icon: "/wallets/coinbase.png",
  },
];

// Icon tile for a wallet row. Detected wallets pass their official EIP-6963
// icon; install suggestions pass their bundled brand icon.
function WalletIcon({
  src,
  alt,
}: {
  src: string;
  alt: string;
}): React.ReactElement {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md">
      <Image alt={alt} height={28} src={src} unoptimized width={28} />
    </span>
  );
}

/**
 * ens.domains / Para-style "Connect" entry point. A single prominent button
 * opens a two-panel modal: injected wallets (discovered via EIP-6963) on the
 * left, email + social sign-in on the right (ConnectAuthPanel). Replaces the
 * bare "Sign In" button.
 */
export function ConnectButton(): React.ReactElement {
  const { refetch } = useSession();
  const wallets = useInjectedWallets();
  // Hide an install suggestion once that wallet is actually detected.
  const installedRdns = new Set(wallets.map((w) => w.info.rdns));
  const installable = POPULAR_WALLETS.filter((w) => !installedRdns.has(w.rdns));
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);

  const handleConnect = async (wallet: DiscoveredWallet): Promise<void> => {
    setConnecting(wallet.info.rdns);
    const result = await loginWithWallet(wallet.provider);
    setConnecting(null);
    if (result.ok) {
      await refetch();
      setOpen(false);
      toast.success(`Connected with ${wallet.info.name}`);
      return;
    }
    if (!result.rejected) {
      toast.error(result.error);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="h-9" size="sm" variant="default">
          Connect
        </Button>
      </DialogTrigger>
      <DialogContent className="overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">Connect to KeeperHub</DialogTitle>
        <div className="grid sm:grid-cols-2">
          {/* Wallets */}
          <div className="flex flex-col gap-3 border-border border-b p-6 sm:border-r sm:border-b-0">
            <div>
              <h2 className="font-semibold text-base">Connect a wallet</h2>
              <p className="text-muted-foreground text-sm">
                Sign in with your wallet. Nothing leaves your device but a
                signature.
              </p>
            </div>

            {wallets.length > 0 && (
              <div className="flex flex-col gap-2">
                {wallets.map((wallet) => (
                  <button
                    className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted disabled:opacity-60"
                    data-testid={`connect-wallet-${wallet.info.rdns}`}
                    disabled={connecting !== null}
                    key={wallet.info.rdns}
                    onClick={() => handleConnect(wallet)}
                    type="button"
                  >
                    <WalletIcon alt={wallet.info.name} src={wallet.info.icon} />
                    <span className="flex-1 font-medium text-sm">
                      {wallet.info.name}
                    </span>
                    {connecting === wallet.info.rdns ? (
                      <Spinner className="size-4" />
                    ) : (
                      <ArrowRight className="size-4 text-muted-foreground" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {installable.length > 0 && (
              <div className="mt-auto">
                <p className="mb-2 text-muted-foreground text-xs">
                  {wallets.length > 0
                    ? "Don't see your wallet? Install one:"
                    : "No wallet detected. Install one to continue:"}
                </p>
                <div className="flex flex-col gap-2">
                  {installable.map((w) => (
                    <a
                      className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted"
                      href={w.installUrl}
                      key={w.rdns}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <WalletIcon alt={w.name} src={w.icon} />
                      <span className="flex-1 font-medium text-sm">
                        {w.name}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        Install
                      </span>
                      <ArrowUpRight className="size-4 text-muted-foreground" />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Log in or sign up */}
          <div className="flex flex-col gap-4 p-6">
            <ConnectAuthPanel />

            <div className="mt-auto border-border border-t pt-4">
              <p className="mb-1 font-medium text-xs">What you can do</p>
              <ul className="space-y-0.5 text-muted-foreground text-xs">
                <li>Build and run automated workflows</li>
                <li>Connect wallets and act on-chain</li>
                <li>Wire up integrations and API keys</li>
              </ul>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
