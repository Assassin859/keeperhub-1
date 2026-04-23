"use client";

import { Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

type ExportStep = "idle" | "requesting" | "otp" | "verifying" | "done";

function getDescription(
  step: ExportStep,
  recipientEmail: string | null
): string {
  if (step === "done") {
    return "Your private key is shown below. Copy it and store it securely.";
  }
  if (step === "requesting") {
    return "Sending a verification code to the wallet's recovery email...";
  }
  if (recipientEmail) {
    return `A verification code has been sent to ${recipientEmail} (the wallet's recovery email).`;
  }
  return "A verification code has been sent to the wallet's recovery email.";
}

export function ExportPrivateKeyButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ExportStep>("idle");
  const [otpCode, setOtpCode] = useState("");
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipientEmail, setRecipientEmail] = useState<string | null>(null);

  const handleOpen = async (): Promise<void> => {
    setOpen(true);
    setStep("requesting");
    setError(null);
    setOtpCode("");
    setPrivateKey(null);
    setRevealed(false);
    setRecipientEmail(null);
    try {
      const res = await fetch("/api/user/wallet/export-key/request", {
        method: "POST",
      });
      const data: { error?: string; email?: string } = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to send verification code");
      }

      setRecipientEmail(data.email ?? null);
      setStep("otp");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send code");
      setOpen(false);
      setStep("idle");
    }
  };

  const handleVerify = async (): Promise<void> => {
    if (otpCode.length !== 6) {
      setError("Enter the 6-digit code from your email");
      return;
    }

    setStep("verifying");
    setError(null);
    try {
      const res = await fetch("/api/user/wallet/export-key/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: otpCode }),
      });
      const data: { privateKey?: string; error?: string } = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Verification failed");
      }

      if (!data.privateKey) {
        throw new Error("No private key returned");
      }

      setPrivateKey(data.privateKey);
      setRevealed(false);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setStep("otp");
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
    setOtpCode("");
    setPrivateKey(null);
    setRevealed(false);
    setError(null);
    setRecipientEmail(null);
  };

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
            <DialogDescription>{getDescription(step, recipientEmail)}</DialogDescription>
          </DialogHeader>

          {step === "requesting" && (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6" />
            </div>
          )}

          {(step === "otp" || step === "verifying") && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="export-otp">Verification Code</Label>
                <Input
                  className="font-mono text-center text-lg tracking-[0.3em]"
                  id="export-otp"
                  maxLength={6}
                  onChange={(e) =>
                    setOtpCode(e.target.value.replace(/\D/g, ""))
                  }
                  placeholder="000000"
                  value={otpCode}
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
                  disabled={step === "verifying" || otpCode.length !== 6}
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
                  {revealed ? privateKey : privateKey.replace(/./g, "\u2022")}
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
