"use client";

import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { RecoveryEmailCard } from "@/components/overlays/wallet/recovery-email-card";
import { SecurityCard } from "@/components/overlays/wallet/security-card";
import { WalletAddressCard } from "@/components/overlays/wallet/wallet-address-card";
import { SafeSigningToggle } from "@/components/safe/safe-signing-toggle";

type SettingsTabProps = {
  account: WalletAccountKind;
  email?: string;
  isOwner: boolean;
  isAdmin: boolean;
  canExportKey: boolean;
  /** Re-fetch wallet/safe data when the signing toggle flips on a Safe. */
  onSigningChange?: (next: boolean) => void;
};

/**
 * Per-account settings.
 *
 * - Turnkey EOA: address card, recovery email, key-export button (owners
 *   with the entitlement). These all act on the org's single Turnkey
 *   wallet so they're not duplicated per chain.
 * - Safe: address card + per-chain signing toggle. The wallet address is
 *   the Safe address (different per chain), so it lives in the per-account
 *   settings rather than at the org-wallet level.
 */
export function SettingsTab({
  account,
  email,
  isOwner,
  isAdmin,
  canExportKey,
  onSigningChange,
}: SettingsTabProps): React.ReactElement {
  if (account.kind === "turnkey") {
    return (
      <div className="space-y-4">
        <WalletAddressCard walletAddress={account.address} />
        {email && <RecoveryEmailCard email={email} />}
        {isOwner && canExportKey && <SecurityCard />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <WalletAddressCard walletAddress={account.address} />
      <SafeSigningToggle
        chainLabel={account.chainName}
        isActive={account.isSigningActive}
        isAdmin={isAdmin}
        onChange={(next) => onSigningChange?.(next)}
        safeId={account.safeId}
      />
    </div>
  );
}
