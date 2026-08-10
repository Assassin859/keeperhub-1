"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { toChecksumAddress } from "@/lib/address-utils";
import { useOrgWallet } from "@/lib/wallet/use-org-wallet";
import {
  accountSlug,
  accountTitle,
  useWalletAccounts,
} from "@/lib/wallet/use-wallet-accounts";
import { SectionHeader, SettingsCard } from "../section";
import { useSettingsContext } from "../settings-context";
import { FormSkeleton, RowsSkeleton } from "../skeletons";
import { AccountDetailPanel } from "./account-detail-panel";

export function AccountDetailSection({
  accountId,
}: {
  accountId: string;
}): React.ReactElement {
  const { organizationId } = useSettingsContext();
  const state = useOrgWallet();
  const { all } = useWalletAccounts({
    chains: state.chains,
    safes: state.safes,
    solanaAddress: state.walletData?.solanaAddress,
    solanaIsTestnet: state.solanaIsTestnet,
    walletAddress: state.walletData?.walletAddress,
  });
  const account = all.find((a) => accountSlug(a) === accountId);

  const back = (
    <Button asChild size="sm" variant="outline">
      <Link href={`/settings/${organizationId}/wallets`}>
        <ArrowLeft className="size-3.5" />
        All wallets
      </Link>
    </Button>
  );

  if (state.walletLoading) {
    return (
      <>
        <SectionHeader action={back} title="Account" />
        <SettingsCard title="Assets">
          <RowsSkeleton rows={4} />
        </SettingsCard>
        <SettingsCard title="Account settings">
          <FormSkeleton rows={2} />
        </SettingsCard>
      </>
    );
  }

  if (!account) {
    return (
      <>
        <SectionHeader
          action={back}
          description="This account is not part of the current organization."
          title="Account not found"
        />
      </>
    );
  }

  return (
    <>
      <SectionHeader
        action={back}
        description={toChecksumAddress(account.address)}
        title={accountTitle(account)}
      />
      <AccountDetailPanel account={account} state={state} />
    </>
  );
}
