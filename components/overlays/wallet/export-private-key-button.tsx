"use client";

import { Copy, Eye, EyeOff, KeyRound } from "lucide-react";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { handleGuardError } from "@/lib/client/handle-guard-error";

type ExportStep = "idle" | "totp" | "verifying" | "done";

export function ExportPrivateKeyButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ExportStep>("idle");
  const [totpCode, setTotpCode] = useState("");
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open: openOverlay } = useOverlay();
  const router = useRouter();

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
    setStep("totp");
    setError(null);
    setTotpCode("");
    setPrivateKey(null);
    setRevealed(false);
  };

  const handleVerify = async (): Promise<void> => {
    if (totpCode.length !== 6) {
      setError("Enter the 6-digit code from your authenticator app");
      return;
    }

    setStep("verifying");
    setError(null);
    try {
      const res = await fetch("/api/user/wallet/export-key/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode }),
      });

      if (!res.ok) {
        const guarded = await handleGuardError(res, guardOptions);
        if (guarded) {
          setStep("totp");
          return;
        }
        const data: { error?: string } = await res.json();
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
    setPrivateKey(null);
    setRevealed(false);
    setError(null);
  };

  const description =
    step === "done"
      ? "Your private key is shown below. Copy it and store it securely."
      : "Enter the current 6-digit code from your authenticator app to confirm.";

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

          {(step === "totp" || step === "verifying") && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="export-totp">Authenticator code</Label>
                <Input
                  autoComplete="one-time-code"
                  autoFocus
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
                {error && <p className="text-destructive text-sm">{error}</p>}
              </div>
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
                  disabled={step === "verifying" || totpCode.length !== 6}
                  onClick={handleVerify}
                >
                  {step === "verifying" ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4" />
                      Verifying...
                    </>
                  ) : (
                    "Verify & Export"
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
