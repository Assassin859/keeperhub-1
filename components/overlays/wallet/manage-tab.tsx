"use client";

import { SafeWalletsEntryCard } from "@/components/safe/safe-wallets-entry-card";
import { RecoveryEmailCard } from "./recovery-email-card";
import { SecurityCard } from "./security-card";
import { WalletAddressCard } from "./wallet-address-card";

export function ManageTab({
  canExportKey,
  email,
  isAdmin,
  isOwner,
  onOpenSafeView,
  walletAddress,
}: {
  canExportKey: boolean;
  email: string;
  isAdmin: boolean;
  isOwner: boolean;
  onOpenSafeView: () => void;
  walletAddress: string;
}): React.ReactElement {
  return (
    <>
      <WalletAddressCard walletAddress={walletAddress} />
      <RecoveryEmailCard email={email} />
      {isOwner && canExportKey && <SecurityCard />}
      <SafeWalletsEntryCard isAdmin={isAdmin} onOpen={onOpenSafeView} />
    </>
  );
}
