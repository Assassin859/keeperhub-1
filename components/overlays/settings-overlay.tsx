"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AccountSettings } from "@/components/settings/account-settings";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChangePasswordSection } from "@/components/settings/change-password-section";
import { DeactivateAccountSection } from "@/components/settings/delete-account-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type SettingsOverlayProps = {
  overlayId: string;
};

export function SettingsOverlay({ overlayId }: SettingsOverlayProps) {
  const { closeAll } = useOverlay();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Account state
  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [awaitingEmailOtp, setAwaitingEmailOtp] = useState(false);

  const session = useSession();
  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;
  const emailChanged = accountEmail.trim() !== originalEmail;
  const showMfaCode = mfaEnrolled && emailChanged;

  const loadAccount = useCallback(async () => {
    try {
      const data = await api.user.get();
      setAccountName(data.name || "");
      setAccountEmail(data.email || "");
      setOriginalEmail(data.email || "");
      setTotpCode("");
      setProviderId(data.providerId ?? null);
    } catch (error) {
      console.error("Failed to load account:", error);
    }
  }, []);

  const loadAll = useCallback(async () => {
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

  const saveAccount = async () => {
    if (showMfaCode && totpCode.trim().length !== 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    if (showMfaCode && awaitingEmailOtp && emailOtp.trim().length !== 6) {
      toast.error("Enter the 6-digit code we emailed you");
      return;
    }
    try {
      setSaving(true);
      // Switch to raw fetch for the email-change path so the
      // dual-factor response codes (factors_required / *_invalid) can
      // be inspected directly rather than parsed out of a thrown
      // Error message.
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountName,
          email: accountEmail,
          code: showMfaCode ? totpCode.trim() : undefined,
          emailOtp:
            showMfaCode && emailOtp.trim() ? emailOtp.trim() : undefined,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (data.code === "factors_required") {
          setAwaitingEmailOtp(true);
          setEmailOtp("");
          toast.success("We just emailed you a confirmation code");
          return;
        }
        if (data.code === "mfa_code_invalid") {
          toast.error(data.error ?? "Invalid authenticator code");
          setTotpCode("");
          return;
        }
        if (data.code === "email_code_invalid") {
          toast.error(data.error ?? "Invalid email code");
          setEmailOtp("");
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
          </TabsList>

          <TabsContent className="space-y-6" value="account">
            <AccountSettings
              accountEmail={accountEmail}
              accountName={accountName}
              awaitingEmailOtp={awaitingEmailOtp && showMfaCode}
              emailOtp={emailOtp}
              onEmailChange={setAccountEmail}
              onEmailOtpChange={setEmailOtp}
              onNameChange={setAccountName}
              onTotpChange={setTotpCode}
              showMfaCode={showMfaCode}
              totpCode={totpCode}
            />
            <DeactivateAccountSection />
          </TabsContent>

          <TabsContent className="space-y-6" value="security">
            <TwoFactorSection />
            <ChangePasswordSection providerId={providerId} />
          </TabsContent>
        </Tabs>
      )}
    </Overlay>
  );
}
