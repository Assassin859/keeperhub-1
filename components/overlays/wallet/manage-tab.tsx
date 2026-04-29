"use client";

import { DeploySafeCard } from "@/components/safe/deploy-safe-card";
import { RecoveryEmailCard } from "./recovery-email-card";
import { SecurityCard } from "./security-card";
import { WalletAddressCard } from "./wallet-address-card";

export function ManageTab({
  canExportKey,
  email,
  isOwner,
  walletAddress,
}: {
  canExportKey: boolean;
  email: string;
  isOwner: boolean;
  walletAddress: string;
}): React.ReactElement {
  return (
    <>
      <WalletAddressCard walletAddress={walletAddress} />
      <RecoveryEmailCard email={email} />
      {isOwner && canExportKey && <SecurityCard />}
      <DeploySafeCard isAdmin={isOwner} />
    </>
  );
}
