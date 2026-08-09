"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";

type DualFactorState = ReturnType<typeof useDualFactorState>;

export type AccountState = {
  name: string;
  email: string;
  providerId: string | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  /** True when the pending email change needs a TOTP code to go through. */
  showMfaCode: boolean;
  dual: DualFactorState;
  setName: (next: string) => void;
  setEmail: (next: string) => void;
  reset: () => void;
  save: () => Promise<void>;
};

export function useAccount(): AccountState {
  const session = useSession();
  const dual = useDualFactorState();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedEmail, setSavedEmail] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const mfaEnrolled =
    (session.data?.user as { twoFactorEnabled?: boolean | null } | undefined)
      ?.twoFactorEnabled === true;
  const emailChanged = email.trim() !== savedEmail;
  const showMfaCode = mfaEnrolled && emailChanged;

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await api.user.get();
      setName(data.name || "");
      setEmail(data.email || "");
      setSavedName(data.name || "");
      setSavedEmail(data.email || "");
      setProviderId(data.providerId ?? null);
      dual.reset();
    } catch {
      toast.error("Could not load your account.");
    } finally {
      setLoading(false);
    }
    // dual.reset is a stable closure over useState setters.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reset = useCallback((): void => {
    setName(savedName);
    setEmail(savedEmail);
    dual.reset();
    // biome-ignore lint/correctness/useExhaustiveDependencies: dual.reset is stable
  }, [savedName, savedEmail]);

  const save = useCallback(async (): Promise<void> => {
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
    setSaving(true);
    try {
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
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
      await load();
      toast.success("Profile saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    } finally {
      setSaving(false);
    }
  }, [name, email, showMfaCode, dual, load]);

  return {
    dirty: emailChanged || name.trim() !== savedName,
    dual,
    email,
    loading,
    name,
    providerId,
    reset,
    save,
    saving,
    setEmail,
    setName,
    showMfaCode,
  };
}
