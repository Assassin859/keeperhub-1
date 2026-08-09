"use client";

import { useRouter } from "next/navigation";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WalletAccountsPanel } from "@/components/overlays/wallet/accounts-panel";
import { NoWalletSection } from "@/components/overlays/wallet/no-wallet-section";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { useOrgWallet } from "@/lib/wallet/use-org-wallet";
import { accountSlug } from "@/lib/wallet/use-wallet-accounts";

type WalletOverlayProps = {
  overlayId: string;
};

export function WalletOverlay({
  overlayId,
}: WalletOverlayProps): React.ReactElement {
  const { closeAll } = useOverlay();
  const router = useRouter();
  const { data: session } = useSession();
  const { isAdmin } = useActiveMember();
  const state = useOrgWallet();

  return (
    <Overlay
      actions={[{ label: "Done", onClick: closeAll }]}
      overlayId={overlayId}
      title="Organization Wallet"
    >
      {state.walletLoading && (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      )}

      {!state.walletLoading && state.walletData?.hasWallet && (
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Pick an account to manage. Assets, policies and settings open in
            full settings.
          </p>
          <WalletAccountsPanel
            onSelectAccount={(account) => {
              closeAll();
              router.push(`/settings/wallets/${accountSlug(account)}`);
            }}
            state={state}
          />
        </div>
      )}

      {!(state.walletLoading || state.walletData?.hasWallet) && (
        <NoWalletSection
          initialEmail={session?.user?.email ?? ""}
          isAdmin={isAdmin}
          onCreateWallet={state.handleCreateWallet}
        />
      )}
    </Overlay>
  );
}
