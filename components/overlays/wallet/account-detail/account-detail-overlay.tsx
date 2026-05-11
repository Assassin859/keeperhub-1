"use client";

import { useState } from "react";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  ChainBalance,
  ChainData,
  SupportedTokenBalance,
  TokenBalance,
} from "@/lib/wallet/types";
import { AssetsTab } from "./assets-tab";
import { PoliciesTab } from "./policies-tab";
import { SettingsTab } from "./settings-tab";

type DetailTab = "assets" | "policies" | "settings";

type AccountDetailOverlayProps = {
  overlayId: string;
  account: WalletAccountKind;
  /** Wallet-overlay-supplied data so we share the same fetch state. */
  chains: ChainData[];
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  isLoadingBalances: boolean;
  email?: string;
  isOwner: boolean;
  isAdmin: boolean;
  canExportKey: boolean;
  onAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  onRemoveToken: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
  /** Triggered after a Safe signing toggle flip so the parent can refresh. */
  onSigningChange?: (next: boolean) => void;
};

function defaultTab(account: WalletAccountKind): DetailTab {
  return account.kind === "safe" ? "assets" : "assets";
}

function detailTitle(account: WalletAccountKind): string {
  if (account.kind === "turnkey") {
    return "Turnkey EOA";
  }
  return `Safe · ${account.chainName}`;
}

/**
 * Per-account detail view. Stacked above the WalletOverlay via
 * `push(AccountDetailOverlay, ...)`. The overlay container handles the
 * slide-in/out animation; we just render the tab body.
 */
export function AccountDetailOverlay({
  overlayId,
  account,
  chains,
  balances,
  tokenBalances,
  supportedTokenBalances,
  isLoadingBalances,
  email,
  isOwner,
  isAdmin,
  canExportKey,
  onAddToken,
  onRemoveToken,
  onWithdraw,
  onSigningChange,
}: AccountDetailOverlayProps): React.ReactElement {
  const { pop } = useOverlay();
  const [tab, setTab] = useState<DetailTab>(defaultTab(account));

  const isSafe = account.kind === "safe";

  return (
    <Overlay
      actions={[{ label: "Back", onClick: pop, variant: "outline" }]}
      // Lock height so switching between Assets / Policies / Settings doesn't
      // make the modal jump as content reflows.
      className="min-h-[80vh] max-h-[80vh]"
      overlayId={overlayId}
      title={detailTitle(account)}
    >
      <Tabs
        className="w-full"
        onValueChange={(v) => setTab(v as DetailTab)}
        value={tab}
      >
        <TabsList className="w-full">
          <TabsTrigger value="assets">Assets</TabsTrigger>
          {isSafe && <TabsTrigger value="policies">Policies</TabsTrigger>}
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="assets">
          <AssetsTab
            account={account}
            balances={balances}
            chains={chains}
            isAdmin={isAdmin}
            isLoadingBalances={isLoadingBalances}
            onAddToken={onAddToken}
            onRemoveToken={onRemoveToken}
            onWithdraw={onWithdraw}
            supportedTokenBalances={supportedTokenBalances}
            tokenBalances={tokenBalances}
          />
        </TabsContent>

        {isSafe && (
          <TabsContent className="mt-4" value="policies">
            <PoliciesTab
              chainId={account.chainId}
              isAdmin={isAdmin}
              safeAddress={account.address}
              safeId={account.safeId}
            />
          </TabsContent>
        )}

        <TabsContent className="mt-4" value="settings">
          <SettingsTab
            account={account}
            canExportKey={canExportKey}
            email={email}
            isOwner={isOwner}
          />
        </TabsContent>
      </Tabs>
    </Overlay>
  );
}
