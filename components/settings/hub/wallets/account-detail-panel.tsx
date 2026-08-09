"use client";

import { useState } from "react";
import { PoliciesTab } from "@/components/overlays/wallet/account-detail/policies-tab";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { Button } from "@/components/ui/button";
import { useAccountDetail } from "@/lib/wallet/use-account-detail";
import type { OrgWalletState } from "@/lib/wallet/use-org-wallet";
import { EmptyState, SettingsCard, StatTile } from "../section";
import { useSettingsContext } from "../settings-context";
import { RowsSkeleton, StatTilesSkeleton } from "../skeletons";
import { AccountSettingsCard } from "./account-settings-card";
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
  const { rows, hiddenCount } = useAccountAssets(
    account,
    detail,
    state.chains,
    showZero
  );
  const isSafe = account.kind === "safe";
  const networks = new Set(rows.map((r) => r.chainId)).size;

  return (
    <>
      {detail.isLoadingBalances ? (
        <StatTilesSkeleton tiles={3} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            hint="Networks with a balance here"
            label="Funded networks"
            value={String(networks)}
          />
          <StatTile
            hint="Native and token balances"
            label="Assets held"
            value={String(rows.filter((r) => !showZero || Number.parseFloat(r.balance) > 0).length)}
          />
          <StatTile
            hint={isSafe ? "Safe smart account" : "Turnkey signer"}
            label="Account type"
            value={isSafe ? "Safe" : "EOA"}
          />
        </div>
      )}

      <SettingsCard
        action={
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
        description="Everything this account can move. Withdraw sends from this address."
        title="Assets"
      >
        {detail.isLoadingBalances && <RowsSkeleton rows={4} />}
        {!detail.isLoadingBalances && rows.length === 0 && (
          <EmptyState>
            No balances yet. Send funds to the address below to get started.
          </EmptyState>
        )}
        {!detail.isLoadingBalances && rows.length > 0 && (
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
