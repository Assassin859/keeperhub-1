"use client";

import type { WalletInfo } from "@/lib/wallet/types";
import { RecoveryEmailCard } from "./recovery-email-card";
import { SecurityCard } from "./security-card";
import { WalletAddressCard } from "./wallet-address-card";
import { WalletSwitcher } from "./wallet-switcher";

export function ManageTab({
  canExportKey,
  email,
  isAdmin,
  onEmailUpdated,
  onSelectActiveWallet,
  switchingWallet,
  walletAddress,
  wallets,
}: {
  canExportKey: boolean;
  email: string;
  isAdmin: boolean;
  onEmailUpdated: () => void;
  onSelectActiveWallet: (walletId: string) => void;
  switchingWallet: boolean;
  walletAddress: string;
  wallets: WalletInfo[] | undefined;
}): React.ReactElement {
  return (
    <>
      {wallets && wallets.length > 1 && (
        <WalletSwitcher
          isAdmin={isAdmin}
          onSelect={onSelectActiveWallet}
          switching={switchingWallet}
          wallets={wallets}
        />
      )}
      <WalletAddressCard walletAddress={walletAddress} />
      <RecoveryEmailCard
        email={email}
        isAdmin={isAdmin}
        onUpdated={onEmailUpdated}
      />
      {isAdmin && canExportKey && <SecurityCard />}
    </>
  );
}
