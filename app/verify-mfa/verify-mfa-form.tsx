"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";

type Props = {
  next: string;
};

/**
 * Step-up MFA modal. Renders as a Dialog (not an inline card) so the
 * underlying page can't be visually composed with the prompt and there
 * is no ambiguity that the user has to confirm before reaching the
 * app. The Dialog is locked open; the only way out is to complete
 * verification (router.replace) or sign out (handled elsewhere).
 */
export function VerifyMfaForm({ next }: Props): React.ReactElement {
  const router = useRouter();
  const dual = useDualFactorState();
  const [busy, setBusy] = useState(false);

  const emptyCodesFetch = (): Promise<Response> =>
    fetch("/api/user/totp/verify-stepup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  const handleSubmit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/user/totp/verify-stepup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: dual.totpCode.trim(),
          emailOtp: dual.emailOtp.trim() || undefined,
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
        toast.error(data.error ?? "Invalid code");
        return;
      }
      router.replace(next || "/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-md [&>button[type='button']]:hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Confirm it's you</DialogTitle>
          <DialogDescription>
            Enter the code we just emailed you and the current code from
            your authenticator app to continue.
          </DialogDescription>
        </DialogHeader>
        <DualFactorSteps
          busy={busy}
          dual={dual}
          onBack={() => router.replace("/sign-in")}
          onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
          onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
          onSubmit={handleSubmit}
          submitLabel="Verify"
        />
      </DialogContent>
    </Dialog>
  );
}
