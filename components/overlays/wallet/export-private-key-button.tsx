"use client";

import { Copy, Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { SettingsOverlay } from "@/components/overlays/settings-overlay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { handleGuardError } from "@/lib/client/handle-guard-error";
import { useActiveMember } from "@/lib/hooks/use-organization";

type ExportStep = "idle" | "totp" | "verifying" | "done" | "needs-mfa";

export function ExportPrivateKeyButton(): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ExportStep>("idle");
  const [totpCode, setTotpCode] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [awaitingEmailOtp, setAwaitingEmailOtp] = useState(false);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open: openOverlay } = useOverlay();
  const router = useRouter();

  // Client-side pre-check: hide the button entirely for non-owners
  // and route owners-without-MFA to enrollment instead of the TOTP
  // dialog. Server still enforces the same rules via
  // requireOwnerWithMfa, so this is purely UX hardening — never the
  // sole source of authorization.
  const { role, isLoading: memberLoading } = useActiveMember();
  const session = useSession();
  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const isOwner = role === "owner";
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;

  if (memberLoading || session.isPending) {
    return null;
  }
  if (!isOwner) {
    return null;
  }

  const guardOptions = {
    onEnrollMfa: () => {
      setOpen(false);
      openOverlay(SettingsOverlay);
    },
    onPendingMfa: (next: string) => {
      setOpen(false);
      router.push(`/verify-mfa?next=${encodeURIComponent(next)}`);
    },
  };

  const handleOpen = (): void => {
    setOpen(true);
    setError(null);
    setTotpCode("");
    setPrivateKey(null);
    setRevealed(false);
    // If the owner hasn't enrolled MFA yet, send them to the
    // "enable MFA first" view instead of asking for a TOTP code
    // they don't have. They can hit Settings from this dialog and
    // resume the export afterwards.
    setStep(mfaEnrolled ? "totp" : "needs-mfa");
  };

  const handleVerify = async (): Promise<void> => {
    if (totpCode.length !== 6) {
      setError("Enter the 6-digit code from your authenticator app");
      return;
    }
    if (awaitingEmailOtp && emailOtp.length !== 6) {
      setError("Enter the 6-digit code we emailed you");
      return;
    }

    setStep("verifying");
    setError(null);
    try {
      const res = await fetch("/api/user/wallet/export-key/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: totpCode,
          emailOtp: emailOtp || undefined,
        }),
      });

      if (!res.ok) {
        const guarded = await handleGuardError(res, guardOptions);
        if (guarded) {
          setStep("totp");
          return;
        }
        const data: { error?: string; code?: string } = await res.json();
        if (data.code === "factors_required") {
          setAwaitingEmailOtp(true);
          setEmailOtp("");
          setStep("totp");
          toast.success("We just emailed you a confirmation code");
          return;
        }
        if (data.code === "mfa_code_invalid") {
          setTotpCode("");
          setError(data.error ?? "Invalid authenticator code");
          setStep("totp");
          return;
        }
        if (data.code === "email_code_invalid") {
          setEmailOtp("");
          setError(data.error ?? "Invalid email code");
          setStep("totp");
          return;
        }
        throw new Error(data.error ?? "Verification failed");
      }

      const data: { privateKey?: string } = await res.json();
      if (!data.privateKey) {
        throw new Error("No private key returned");
      }

      setPrivateKey(data.privateKey);
      setRevealed(false);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setStep("totp");
    }
  };

  const handleCopy = (): void => {
    if (!privateKey) {
      return;
    }
    navigator.clipboard.writeText(privateKey);
    toast.success("Private key copied to clipboard");
  };

  const handleClose = (): void => {
    setOpen(false);
    setStep("idle");
    setTotpCode("");
    setEmailOtp("");
    setAwaitingEmailOtp(false);
    setPrivateKey(null);
    setRevealed(false);
    setError(null);
  };

  const description = (() => {
    if (step === "done") {
      return "Your private key is shown below. Copy it and store it securely.";
    }
    if (step === "needs-mfa") {
      return "Enable two-factor authentication on your account before exporting a private key.";
    }
    return "Enter the current 6-digit code from your authenticator app to confirm.";
  })();

  return (
    <>
      <Button
        className="w-full"
        onClick={handleOpen}
        size="sm"
        variant="outline"
      >
        <KeyRound className="mr-2 h-3 w-3" />
        Export Private Key
      </Button>

      <Dialog
        onOpenChange={(v) => {
          if (!v) {
            handleClose();
          }
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export Private Key</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {step === "needs-mfa" && (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
                <ShieldAlert
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-amber-500"
                />
                <p className="text-sm">
                  Exporting a private key requires a second factor. Open
                  Settings to enroll your authenticator, then come back to
                  finish the export.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={handleClose} variant="outline">
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    handleClose();
                    openOverlay(SettingsOverlay);
                  }}
                >
                  Open Settings
                </Button>
              </DialogFooter>
            </div>
          )}

          {(step === "totp" || step === "verifying") && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="export-totp">Authenticator code</Label>
                <Input
                  autoComplete="one-time-code"
                  autoFocus={!awaitingEmailOtp}
                  className="font-mono text-center text-lg tracking-[0.3em]"
                  id="export-totp"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, ""))
                  }
                  placeholder="000000"
                  value={totpCode}
                />
              </div>
              {awaitingEmailOtp && (
                <div className="space-y-2">
                  <Label htmlFor="export-email-otp">Email code</Label>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    className="font-mono text-center text-lg tracking-[0.3em]"
                    id="export-email-otp"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) =>
                      setEmailOtp(e.target.value.replace(/\D/g, ""))
                    }
                    placeholder="000000"
                    value={emailOtp}
                  />
                  <p className="text-muted-foreground text-xs">
                    We emailed a 6-digit confirmation code. Enter it above
                    along with your authenticator code.
                  </p>
                </div>
              )}
              {error && <p className="text-destructive text-sm">{error}</p>}
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={step === "verifying"}
                  onClick={handleClose}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  disabled={
                    step === "verifying" ||
                    totpCode.length !== 6 ||
                    (awaitingEmailOtp && emailOtp.length !== 6)
                  }
                  onClick={handleVerify}
                >
                  {step === "verifying" ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4" />
                      Verifying...
                    </>
                  ) : awaitingEmailOtp ? (
                    "Confirm & Export"
                  ) : (
                    "Continue"
                  )}
                </Button>
              </div>
            </div>
          )}

          {step === "done" && privateKey && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-destructive text-sm">
                    Private Key
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      aria-label={
                        revealed ? "Hide private key" : "Reveal private key"
                      }
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setRevealed(!revealed)}
                      type="button"
                    >
                      {revealed ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      aria-label="Copy private key"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={handleCopy}
                      type="button"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <code className="block break-all font-mono text-sm">
                  {revealed ? privateKey : privateKey.replace(/./g, "•")}
                </code>
              </div>
              <Button className="w-full" onClick={handleClose}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
