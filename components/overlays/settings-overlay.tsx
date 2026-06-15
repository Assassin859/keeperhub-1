"use client";

import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { AuditFilterBar } from "@/components/activity/audit-filter-bar";
import { ExportAuditOverlay } from "@/components/overlays/export-audit-overlay";
import { AccountSettings } from "@/components/settings/account-settings";
import { ActiveSessionsSection } from "@/components/settings/active-sessions-section";
import { ChangePasswordSection } from "@/components/settings/change-password-section";
import { DeactivateAccountSection } from "@/components/settings/delete-account-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import {
  PAGE_SIZE_OPTIONS,
  useAuditActivity,
} from "@/lib/hooks/use-audit-activity";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type SettingsOverlayProps = {
  overlayId: string;
};

export function SettingsOverlay({
  overlayId,
}: SettingsOverlayProps): React.ReactElement {
  const { closeAll, push } = useOverlay();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const dual = useDualFactorState();

  const session = useSession();
  const { isAdmin, isOwner } = useActiveMember();
  const activity = useAuditActivity();

  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;
  const emailChanged = accountEmail.trim() !== originalEmail;
  const showMfaCode = mfaEnrolled && emailChanged;

  const loadAccount = useCallback(async (): Promise<void> => {
    try {
      const data = await api.user.get();
      setAccountName(data.name || "");
      setAccountEmail(data.email || "");
      setOriginalEmail(data.email || "");
      dual.reset();
      setProviderId(data.providerId ?? null);
    } catch (error) {
      console.error("Failed to load account:", error);
    }
    // dual.reset is a stable closure over useState setters; intentionally
    // excluded from deps to keep this callback referentially stable.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await loadAccount();
    } finally {
      setLoading(false);
    }
  }, [loadAccount]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveAccount = async (): Promise<void> => {
    if (showMfaCode && dual.totpCode.trim().length !== 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    if (
      showMfaCode &&
      dual.awaitingEmailOtp &&
      dual.emailOtp.trim().length !== 6
    ) {
      toast.error("Enter the 6-digit code we emailed you");
      return;
    }
    try {
      setSaving(true);
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountName,
          email: accountEmail,
          code: showMfaCode ? dual.totpCode.trim() : undefined,
          emailOtp:
            showMfaCode && dual.emailOtp.trim()
              ? dual.emailOtp.trim()
              : undefined,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        throw new Error(data.error ?? "Failed to save settings");
      }
      await loadAccount();
      toast.success("Settings saved");
      closeAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      console.error("Failed to save account:", error);
      toast.error(message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: closeAll },
        {
          label: "Save",
          onClick: saveAccount,
          loading: saving,
          disabled: loading,
        },
      ]}
      overlayId={overlayId}
      title="Settings"
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Update your personal information
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <Tabs className="w-full" defaultValue="account">
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            {isAdmin && <TabsTrigger value="activity">Activity</TabsTrigger>}
          </TabsList>

          <TabsContent className="space-y-6" value="account">
            <AccountSettings
              accountEmail={accountEmail}
              accountName={accountName}
              awaitingEmailOtp={dual.awaitingEmailOtp && showMfaCode}
              emailOtp={dual.emailOtp}
              onEmailChange={setAccountEmail}
              onEmailOtpChange={dual.setEmailOtp}
              onNameChange={setAccountName}
              onTotpChange={dual.setTotpCode}
              showMfaCode={showMfaCode}
              totpCode={dual.totpCode}
            />
            <DeactivateAccountSection />
          </TabsContent>

          <TabsContent className="space-y-6" value="security">
            <TwoFactorSection />
            <ChangePasswordSection providerId={providerId} />
            <ActiveSessionsSection />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="activity">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h3 className="font-medium text-sm">Organization activity</h3>
                  <p className="text-muted-foreground text-xs">
                    Recent security-sensitive actions across your organization.
                  </p>
                </div>
                <Button
                  className="shrink-0"
                  disabled={!isOwner}
                  onClick={() =>
                    push(ExportAuditOverlay, {
                      resourceTypes: activity.types,
                    })
                  }
                  size="sm"
                  title={
                    isOwner ? undefined : "Only organization owners can export"
                  }
                  variant="outline"
                >
                  <Download className="mr-2 size-4" />
                  Export CSV
                </Button>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <AuditFilterBar activity={activity} />
                <Select
                  onValueChange={(v) => activity.setPageSize(Number(v))}
                  value={String(activity.pageSize)}
                >
                  <SelectTrigger className="h-8 w-[110px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size} / page
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="mt-3">
                <ActivityFeed embedded params={activity.feedParams} />
              </div>
            </TabsContent>
          )}
        </Tabs>
      )}
    </Overlay>
  );
}
