"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TotpBackupCodesPanel } from "@/components/settings/totp-backup-codes-panel";
import { TotpQr } from "@/components/settings/totp-qr";
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

type SetupResponse = {
  totpUri: string;
  manualEntryKey: string;
};

type EnrollResponse = {
  backupCodes: string[];
};

type Phase = "scan" | "verify" | "save";

const STEP_DEFS: ReadonlyArray<{ key: Phase; label: string }> = [
  { key: "scan", label: "Scan" },
  { key: "verify", label: "Verify" },
  { key: "save", label: "Save codes" },
] as const;

type StepStatus = "current" | "done" | "pending";

function bubbleClassFor(status: StepStatus): string {
  if (status === "current") {
    return "border-primary bg-primary text-primary-foreground";
  }
  if (status === "done") {
    return "border-primary/40 bg-primary/10 text-primary";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

function labelClassFor(status: StepStatus): string {
  if (status === "current") {
    return "font-medium text-foreground";
  }
  if (status === "done") {
    return "text-foreground";
  }
  return "text-muted-foreground";
}

function statusFor(idx: number, currentIdx: number): StepStatus {
  if (idx === currentIdx) {
    return "current";
  }
  if (idx < currentIdx) {
    return "done";
  }
  return "pending";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrolled: () => void;
};

/**
 * Horizontal numbered stepper, mirrors the deploy-safe wizard
 * (components/safe/deploy-safe-card.tsx:StepIndicator). Same bubble
 * styling, same connector treatment — visual consistency with the
 * existing wizard pattern in the codebase.
 */
function StepIndicator({ current }: { current: Phase }): React.ReactElement {
  const currentIdx = STEP_DEFS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 px-1 pb-1 text-xs">
      {STEP_DEFS.map((s, idx) => {
        const status = statusFor(idx, currentIdx);
        const isLast = idx === STEP_DEFS.length - 1;
        return (
          <li className="flex items-center gap-2" key={s.key}>
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border font-medium text-[10px] ${bubbleClassFor(status)}`}
            >
              {idx + 1}
            </span>
            <span className={labelClassFor(status)}>{s.label}</span>
            {!isLast && (
              <span
                aria-hidden="true"
                className={`h-px w-6 ${status === "done" ? "bg-primary/40" : "bg-border"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Single modal, single step content at a time, horizontal progress
 * indicator at the top. Pattern matches a standard wizard: stepper
 * shows current/done/pending; body swaps per phase; Back/Continue at
 * the bottom move between phases.
 *
 * Phases: scan -> verify -> save. The save phase locks the dialog
 * until the user has copied + downloaded + retyped two backup codes.
 */
export function TotpSetupDialog({
  open,
  onOpenChange,
  onEnrolled,
}: Props): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("scan");
  const [setupData, setSetupData] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || setupData) {
      return;
    }
    let cancelled = false;
    const run = async (): Promise<void> => {
      setBusy(true);
      try {
        const response = await fetch("/api/user/totp/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(data.error ?? "Failed to start setup");
          onOpenChange(false);
          return;
        }
        const data = (await response.json()) as SetupResponse;
        if (!cancelled) {
          setSetupData(data);
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, setupData, onOpenChange]);

  const locked = phase === "save" && backupCodes !== null;

  useEffect(() => {
    if (!locked) {
      return;
    }
    const handler = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      event.returnValue =
        "You have unsaved backup codes. Leaving now means losing them.";
      return event.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [locked]);

  const reset = (): void => {
    setPhase("scan");
    setSetupData(null);
    setCode("");
    setBackupCodes(null);
    setBusy(false);
  };

  const closeAndReset = (): void => {
    reset();
    onOpenChange(false);
  };

  const attemptClose = (): void => {
    if (locked) {
      toast.error("Download your backup codes first.");
      return;
    }
    closeAndReset();
  };

  const handleVerifyAndEnroll = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch("/api/user/totp/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error ?? "Invalid code");
        return;
      }
      const data = (await response.json()) as EnrollResponse;
      setBackupCodes(data.backupCodes);
      setPhase("save");
      onEnrolled();
    } finally {
      setBusy(false);
    }
  };

  const handleBackupCodesConfirmed = (): void => {
    toast.success("Two-factor authentication is enabled");
    closeAndReset();
  };

  const handleCopyKey = async (): Promise<void> => {
    if (!setupData) {
      return;
    }
    try {
      await navigator.clipboard.writeText(setupData.manualEntryKey);
      toast.success("Setup key copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          attemptClose();
          return;
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent
        className={
          locked
            ? "max-h-[90vh] overflow-y-auto sm:max-w-lg [&>button[type='button']]:hidden"
            : "max-h-[90vh] overflow-y-auto sm:max-w-lg"
        }
        onEscapeKeyDown={(event) => {
          if (locked) {
            event.preventDefault();
            toast.error("Download your backup codes before closing.");
          }
        }}
        onInteractOutside={(event) => {
          if (locked) {
            event.preventDefault();
            toast.error("Download your backup codes before closing.");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Set up two-factor authentication</DialogTitle>
          <DialogDescription>
            Three steps. The dialog stays open until your backup codes are
            saved.
          </DialogDescription>
        </DialogHeader>

        <StepIndicator current={phase} />

        {phase === "scan" && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Scan the QR code in your authenticator app (Google
              Authenticator, 1Password, Authy), or paste the setup key.
            </p>
            <div className="flex justify-center">
              {setupData ? (
                <TotpQr data={setupData.totpUri} />
              ) : (
                <div className="flex h-48 w-48 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-xs">
                  {busy ? "Generating QR..." : "Preparing"}
                </div>
              )}
            </div>
            {setupData && (
              <div className="space-y-2">
                <Label>Setup key (manual entry)</Label>
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    readOnly
                    value={setupData.manualEntryKey}
                  />
                  <Button onClick={handleCopyKey} size="sm" variant="outline">
                    Copy
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button onClick={attemptClose} variant="outline">
                Cancel
              </Button>
              <Button
                disabled={!setupData || busy}
                onClick={() => setPhase("verify")}
              >
                Continue
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase === "verify" && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Open your authenticator and enter the 6-digit code it's
              showing right now.
            </p>
            <div className="space-y-2">
              <Label htmlFor="totp-verify-code">Verification code</Label>
              <Input
                autoComplete="one-time-code"
                autoFocus
                id="totp-verify-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.target.value)}
                placeholder="123456"
                value={code}
              />
            </div>
            <DialogFooter>
              <Button
                disabled={busy}
                onClick={() => setPhase("scan")}
                variant="outline"
              >
                Back
              </Button>
              <Button
                disabled={busy || code.trim().length < 6}
                onClick={handleVerifyAndEnroll}
              >
                {busy ? "Verifying..." : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase === "save" && backupCodes && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Two-factor is now active. Save these recovery codes — without
              them, losing your authenticator means losing access.
            </p>
            <TotpBackupCodesPanel
              codes={backupCodes}
              onConfirmed={handleBackupCodesConfirmed}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
