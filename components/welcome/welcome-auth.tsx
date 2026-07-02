"use client";

import { ArrowLeft, Wallet } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { ConnectAuthPanel } from "@/components/auth/connect-auth-panel";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { KeeperHubLogo } from "@/components/icons/keeperhub-logo";
import { Button } from "@/components/ui/button";
import { markContinueAsGuest } from "@/lib/welcome-status";

/**
 * Safe-style welcome / sign-in panel. Presents email + social auth in a single
 * column (via ConnectAuthPanel), a "Sign in with your wallet" action that
 * reveals the wallet picker on click, and a guest escape hatch. The transition
 * between the two views is height-animated to match ConnectAuthPanel's own
 * view changes. Rendered full-screen on the bare-layout /welcome route.
 */
export function WelcomeAuth(): React.ReactElement {
  const [showWallet, setShowWallet] = useState(false);

  // Animate the card height as the view swaps, mirroring ConnectAuthPanel.
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    setHeight(el.scrollHeight);
    return () => observer.disconnect();
  }, []);

  const continueWithoutAccount = (): void => {
    markContinueAsGuest();
    window.location.assign("/");
  };

  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <KeeperHubLogo className="size-9" />
          <h1 className="font-semibold text-2xl tracking-tight">
            Sign in to KeeperHub
          </h1>
        </div>

        <motion.div
          animate={{ height }}
          className="overflow-hidden"
          initial={false}
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          <div ref={contentRef}>
            <AnimatePresence initial={false} mode="popLayout">
              {showWallet ? (
                <motion.div
                  animate={{ opacity: 1 }}
                  className="flex flex-col gap-4"
                  exit={{ opacity: 0, transition: { duration: 0 } }}
                  initial={{ opacity: 0 }}
                  key="wallet"
                  transition={{ opacity: { duration: 0.15, delay: 0.2 } }}
                >
                  <p className="text-muted-foreground text-sm">
                    Nothing leaves your device but a signature.
                  </p>
                  <WalletPicker
                    onConnected={() => window.location.assign("/")}
                  />
                  <Button
                    className="w-full justify-center"
                    onClick={() => setShowWallet(false)}
                    type="button"
                    variant="ghost"
                  >
                    <ArrowLeft className="size-4" />
                    Other ways to sign in
                  </Button>
                </motion.div>
              ) : (
                <motion.div
                  animate={{ opacity: 1 }}
                  className="flex flex-col gap-4"
                  exit={{ opacity: 0, transition: { duration: 0 } }}
                  initial={{ opacity: 0 }}
                  key="socials"
                  transition={{ opacity: { duration: 0.15, delay: 0.2 } }}
                >
                  <ConnectAuthPanel hideChooserHeader />
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-muted-foreground text-xs">OR</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <Button
                    className="w-full justify-start"
                    onClick={() => setShowWallet(true)}
                    type="button"
                    variant="outline"
                  >
                    <Wallet className="size-4" />
                    Sign in with your wallet
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>

      <button
        className="text-center text-muted-foreground text-sm hover:text-foreground"
        onClick={continueWithoutAccount}
        type="button"
      >
        Explore without signing in
      </button>
    </div>
  );
}
