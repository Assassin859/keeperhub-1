"use client";

import { useState } from "react";
import { ConnectAuthPanel } from "@/components/auth/connect-auth-panel";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * ens.domains / Para-style "Connect" entry point. A single prominent button
 * opens a two-panel modal: injected wallets (discovered via EIP-6963) on the
 * left, email + social sign-in on the right (ConnectAuthPanel). Replaces the
 * bare "Sign In" button.
 */
export function ConnectButton(): React.ReactElement {
  const [open, setOpen] = useState(false);

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
            <WalletPicker onConnected={() => setOpen(false)} />
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
