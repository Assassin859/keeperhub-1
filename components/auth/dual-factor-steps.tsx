"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UseDualFactorState } from "@/lib/mfa/use-dual-factor-state";

/**
 * Two-step dual-factor wizard.
 *
 *   Step 1 -- Email code. On entry, the parent's `prefetchEmail`
 *             fires so the verifications row is seeded and the user's
 *             inbox already has the code by the time they look at the
 *             step. User enters the 6-digit code from the email and
 *             clicks Continue.
 *   Step 2 -- Authenticator code. User enters the current 6-digit code
 *             from their authenticator app and clicks Confirm. The
 *             parent's `onSubmit` then POSTs the action endpoint with
 *             both codes; the dual-factor server primitive verifies
 *             them atomically.
 *
 * Visual pattern (numbered bubbles, Back / Continue / Confirm) mirrors
 * components/settings/totp-setup-dialog.tsx so the rest of the app
 * stays consistent.
 */

type DualFactorStepsProps = {
  /**
   * Hook instance. The wizard reads totpCode / emailOtp /
   * awaitingEmailOtp and writes via the setters.
   */
  dual: UseDualFactorState;
  /**
   * Fires the empty-codes POST so the server emails the OTP. Called
   * once on entry into step 1. The hook's `prefetchEmail` already
   * guards against duplicate fires.
   */
  onPrefetchEmail: () => Promise<void>;
  /**
   * User-triggered resend on step 1. Bypasses the hook's prefetch
   * guard so a "didn't get the email" click always re-fires.
   */
  onResendEmail: () => Promise<boolean>;
  /**
   * Fires the final POST with both codes. The parent owns the
   * fetcher, response parsing, and success/error handling.
   */
  onSubmit: () => Promise<void>;
  onBack: () => void;
  /**
   * Submit-button label. Defaults to "Confirm".
   */
  submitLabel?: string;
  /**
   * Variant for the submit button on the final step. Defaults to
   * "default"; pass "destructive" for irreversible actions.
   */
  submitVariant?: "default" | "destructive";
  busy?: boolean;
  /**
   * Optional context line shown above step 1. Use it to remind the
   * user what they are confirming (e.g. "Send 12.34 USDC to 0x...").
   */
  context?: ReactNode;
};

type Phase = "email" | "authenticator";

const STEP_DEFS: ReadonlyArray<{ key: Phase; label: string }> = [
  { key: "email", label: "Email code" },
  { key: "authenticator", label: "Authenticator" },
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

function StepIndicator({
  current,
}: {
  current: Phase;
}): React.ReactElement {
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

const INPUT_CLASSES = "font-mono text-center text-lg tracking-[0.3em]";

const numericOnly = (value: string): string => value.replace(/\D/g, "");

export function DualFactorSteps({
  dual,
  onPrefetchEmail,
  onResendEmail,
  onSubmit,
  onBack,
  submitLabel = "Confirm",
  submitVariant = "default",
  busy = false,
  context,
}: DualFactorStepsProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("email");
  const [resending, setResending] = useState(false);

  useEffect(() => {
    onPrefetchEmail();
    // onPrefetchEmail is intentionally excluded so the wizard fires
    // it exactly once on mount; the hook already guards against
    // duplicate fires for the same instance.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  }, []);

  const handleResend = async (): Promise<void> => {
    setResending(true);
    try {
      const ok = await onResendEmail();
      if (ok) {
        dual.setEmailOtp("");
      }
    } finally {
      setResending(false);
    }
  };

  const emailReady = dual.emailOtp.trim().length === 6;
  const totpReady = dual.totpCode.trim().length === 6;

  return (
    <div className="space-y-4">
      <StepIndicator current={phase} />

      {context && (
        <p className="text-muted-foreground text-sm">{context}</p>
      )}

      {phase === "email" && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="dfs-email">Email code</Label>
            <Input
              autoComplete="one-time-code"
              autoFocus
              className={INPUT_CLASSES}
              disabled={busy}
              id="dfs-email"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) =>
                dual.setEmailOtp(numericOnly(event.target.value))
              }
              placeholder="000000"
              value={dual.emailOtp}
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                {dual.awaitingEmailOtp
                  ? "We just emailed you a 6-digit code. It expires in 5 minutes."
                  : "Sending the code to your email..."}
              </p>
              <Button
                disabled={busy || resending}
                onClick={handleResend}
                size="sm"
                type="button"
                variant="ghost"
              >
                {resending ? "Sending..." : "Resend"}
              </Button>
            </div>
          </div>
          <div className="flex justify-between">
            <Button disabled={busy} onClick={onBack} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={busy || !emailReady}
              onClick={() => setPhase("authenticator")}
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {phase === "authenticator" && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="dfs-totp">Authenticator code</Label>
            <Input
              autoComplete="one-time-code"
              autoFocus
              className={INPUT_CLASSES}
              disabled={busy}
              id="dfs-totp"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) =>
                dual.setTotpCode(numericOnly(event.target.value))
              }
              placeholder="000000"
              value={dual.totpCode}
            />
            <p className="text-muted-foreground text-xs">
              Open your authenticator app and enter the code it is
              showing right now.
            </p>
          </div>
          <div className="flex justify-between">
            <Button
              disabled={busy}
              onClick={() => setPhase("email")}
              variant="outline"
            >
              Back
            </Button>
            <Button
              disabled={busy || !(emailReady && totpReady)}
              onClick={onSubmit}
              variant={submitVariant}
            >
              {busy ? "Working..." : submitLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
