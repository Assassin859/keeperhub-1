"use client";

import { DeactivateAccountSection } from "@/components/settings/delete-account-section";
import { ProfileForm } from "./account/profile-form";
import { useAccount } from "./hooks/use-account";
import { SectionHeader, SettingsCard } from "./section";
import { FormSkeleton } from "./skeletons";

export function ProfileSection(): React.ReactElement {
  const account = useAccount();

  return (
    <>
      <SectionHeader
        description="Your name and the email you sign in with."
        title="Profile"
      />

      <SettingsCard title="Account details">
        {account.loading ? <FormSkeleton rows={2} /> : <ProfileForm account={account} />}
      </SettingsCard>

      <SettingsCard
        className="border-destructive/30"
        description="Deactivating stops every workflow in every organization you own. This cannot be undone."
        title="Deactivate account"
      >
        <DeactivateAccountSection />
      </SettingsCard>
    </>
  );
}
