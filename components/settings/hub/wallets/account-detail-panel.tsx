"use client";

import { useState } from "react";
import { PoliciesTab } from "@/components/overlays/wallet/account-detail/policies-tab";
import { SolanaAssets } from "@/components/overlays/wallet/account-detail/solana-assets";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { SafeSigningToggle } from "@/components/safe/safe-signing-toggle";
import { Button } from "@/components/ui/button";
import { useAccountDetail } from "@/lib/wallet/use-account-detail";
import type { OrgWalletState } from "@/lib/wallet/use-org-wallet";
import { EmptyState, SettingsCard } from "../section";
import { useSettingsContext } from "../settings-context";
import { RowsSkeleton, StatTilesSkeleton } from "../skeletons";
import { AccountSettingsCard } from "./account-settings-card";
import { AccountStats } from "./account-stats";
import { AssetsTable } from "./assets-table";
import { useAccountAssets } from "./use-account-assets";

/**
 * The per-account view, rendered inline on its own route: a flat asset table
 * instead of the modal's nested per-chain accordion.
 */
export function AccountDetailPanel({
  account,
  state,
}: {
  account: WalletAccountKind;
  state: OrgWalletState;
}): React.ReactElement {
  const { isAdmin, isOwner } = useSettingsContext();
  const detail = useAccountDetail(account, state);
  const [showZero, setShowZero] = useState(false);
  const { rows, funded, hiddenCount } = useAccountAssets(
    account,
    detail,
    state.chains,
    showZero
  );
  const isSafe = account.kind === "safe";
  // The Solana signer has its own balance source; the EVM chain feed does not
  // describe it, so it gets the dedicated view the wallet modal also uses.
  const isSolana = account.kind === "turnkey" && account.family === "solana";

  return (
    <>
      {detail.isLoadingBalances && !isSolana ? (
        <StatTilesSkeleton tiles={3} />
      ) : (
        <AccountStats
          account={account}
          funded={funded}
          solanaIsTestnet={state.solanaIsTestnet}
        />
      )}

      <SettingsCard
        action={
          !isSolana &&
          hiddenCount > 0 && (
            <Button
              onClick={() => setShowZero((v) => !v)}
              size="sm"
              variant="ghost"
            >
              {showZero ? "Hide empty" : `Show ${hiddenCount} empty`}
            </Button>
          )
        }
        bodyClassName="p-2"
        description={
          isSolana
            ? "Native SOL held by this signer."
            : "Everything this account can move. Withdraw sends from this address."
        }
        title="Assets"
      >
        {isSolana && (
          <div className="p-3">
            <SolanaAssets address={account.address} />
          </div>
        )}
        {!isSolana && detail.isLoadingBalances && <RowsSkeleton rows={4} />}
        {!(isSolana || detail.isLoadingBalances) && rows.length === 0 && (
          <EmptyState>
            No balances yet. Send funds to the address below to get started.
          </EmptyState>
        )}
        {!(isSolana || detail.isLoadingBalances) && rows.length > 0 && (
          <AssetsTable
            canWithdraw={isAdmin}
            onWithdraw={detail.withdraw}
            rows={rows}
          />
        )}
      </SettingsCard>

      {isSafe && (
        <SettingsCard
          description="What this Safe is allowed to do on chain, and who can propose it."
          title="Policies"
        >
          <PoliciesTab
            chainId={account.chainId}
            isAdmin={isAdmin}
            isOwner={isOwner}
            safeAddress={account.address}
            safeId={account.safeId}
          />
        </SettingsCard>
      )}

      {isSafe && (
        <SettingsCard
          description="Workflow transactions are sent from this Safe when it is on. The Turnkey signer signs either way; this only decides which account the transaction comes from."
          title="Send from this Safe"
        >
          <SafeSigningToggle
            chainLabel={account.chainName}
            isActive={account.isSigningActive}
            isAdmin={isAdmin}
            onChange={(next) =>
              state.setSafes((current) =>
                current.map((s) =>
                  s.id === account.safeId ? { ...s, isSigningActive: next } : s
                )
              )
            }
            safeId={account.safeId}
          />
        </SettingsCard>
      )}

      <AccountSettingsCard
        account={account}
        canExportKey={!!state.walletData?.canExportKey}
        email={state.walletData?.email}
        isOwner={isOwner}
        solanaAddress={state.walletData?.solanaAddress}
      />
    </>
  );
}
