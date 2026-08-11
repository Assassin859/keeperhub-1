"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { toChecksumAddress } from "@/lib/address-utils";
import { useOrgWallet } from "@/lib/wallet/use-org-wallet";
import {
  accountSlug,
  accountTitle,
  accountTitleForSlug,
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
    <Button aria-label="All wallets" asChild size="icon" variant="outline">
      <Link href={`/settings/${organizationId}/wallets`}>
        <ArrowLeft className="size-4" />
      </Link>
    </Button>
  );

  // A Safe is only missing once the Safes have actually been fetched; they
  // arrive after the wallet, and until then the list is simply empty.
  const isSignerSlug = accountId === "evm" || accountId === "solana";
  const pending =
    state.walletLoading ||
    (!isSignerSlug &&
      state.walletData?.hasWallet === true &&
      !state.safesLoaded);

  if (pending) {
    return (
      <>
        <SectionHeader leading={back} title={accountTitleForSlug(accountId)} />
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
          description="This account is not part of the current organization."
          leading={back}
          title="Account not found"
        />
      </>
    );
  }

  return (
    <>
      <SectionHeader
        description={toChecksumAddress(account.address)}
        leading={back}
        title={accountTitle(account)}
      />
      <AccountDetailPanel account={account} state={state} />
    </>
  );
}
