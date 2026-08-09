"use client";

import { useState } from "react";
import { MfaEnforcementSection } from "@/components/organization/mfa-enforcement-section";
import { ChangePasswordSection } from "@/components/settings/change-password-section";
import { WalletSecuritySection } from "@/components/settings/wallet-security-section";
import { useAccount } from "./hooks/use-account";
import { type SessionRow, useSecurity } from "./hooks/use-security";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { RevokeSessionPanel } from "./security/revoke-session-panel";
import { SessionsTable } from "./security/sessions-table";
import { TwoFactorCard } from "./security/two-factor-card";
import { useSettingsContext } from "./settings-context";
import { RowsSkeleton } from "./skeletons";

export function SecuritySection(): React.ReactElement {
  const { providerId, loading } = useAccount();
  const { organizationId, isAdmin, isOwner } = useSettingsContext();
  const security = useSecurity();
  const [revoking, setRevoking] = useState<SessionRow | null>(null);
  const isWalletAccount = providerId === "siwe";

  return (
    <>
      <SectionHeader
        description="What it takes to sign in as you, and which devices currently can."
        title="Security"
      />

      {isWalletAccount ? (
        <SettingsCard
          description="Your wallet signature is the first factor. Add a recovery email or an authenticator for step-up."
          title="Wallet step-up"
        >
          <WalletSecuritySection />
        </SettingsCard>
      ) : (
        <>
          <TwoFactorCard
            loading={security.totpLoading}
            onChanged={security.reloadTotp}
            status={security.totp}
          />
          <SettingsCard
            description="Changing your password signs out every other device."
            title="Password"
          >
            {loading ? null : <ChangePasswordSection providerId={providerId} />}
          </SettingsCard>
        </>
      )}

      <SettingsCard
        bodyClassName="p-2"
        description="Every browser and device currently holding a session for this account."
        title="Active sessions"
      >
        {security.sessionsLoading && <RowsSkeleton rows={2} />}
        {!security.sessionsLoading && security.sessions.length === 0 && (
          <EmptyState>No other sessions are active.</EmptyState>
        )}
        {!security.sessionsLoading && security.sessions.length > 0 && (
          <>
            <SessionsTable
              onRevoke={setRevoking}
              sessions={security.sessions}
            />
            {revoking && (
              <RevokeSessionPanel
                onCancel={() => setRevoking(null)}
                onDone={async () => {
                  setRevoking(null);
                  await security.reloadSessions();
                }}
                session={revoking}
              />
            )}
          </>
        )}
      </SettingsCard>

      {isAdmin && organizationId && (
        <SettingsCard
          description="Require every member of this organization to enrol a second factor before they can run workflows."
          title="Organization MFA enforcement"
        >
          <MfaEnforcementSection
            canEdit={isOwner}
            organizationId={organizationId}
          />
        </SettingsCard>
      )}
    </>
  );
}
