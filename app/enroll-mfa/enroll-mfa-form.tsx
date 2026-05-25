"use client";

import { CheckCircle2, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Props = {
  next: string;
};

const REDIRECT_COUNTDOWN_SECONDS = 10;

/**
 * Forced enrollment surface. The page is reached only when
 * users.two_factor_enabled = false; the proxy keeps redirecting here
 * until that flips to true. The wizard cannot be dismissed before the
 * user has finished all three phases (scan, verify, save backup codes).
 * Server-side enrollment completes after the verify step, but the
 * dialog stays open through the save-codes phase. After the user
 * confirms they saved their codes the dialog closes and this surface
 * swaps to a success card with a 10-second auto-redirect plus a
 * Continue button so the redirect is acknowledged rather than abrupt.
 */
export function EnrollMfaForm({ next }: Props): React.ReactElement {
  const target = next || "/";
  const [dialogOpen, setDialogOpen] = useState(true);
  const [enrolled, setEnrolled] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_COUNTDOWN_SECONDS);

  const handleEnrolled = (): void => {
    setEnrolled(true);
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      return;
    }
    if (!enrolled) {
      // Pre-enrollment phases cannot be dismissed from this surface.
      return;
    }
    setDialogOpen(false);
    setShowSuccess(true);
  };

  const handleContinue = (): void => {
    window.location.assign(target);
  };

  useEffect(() => {
    if (!showSuccess) {
      return;
    }
    if (secondsLeft <= 0) {
      window.location.assign(target);
      return;
    }
    const timer = window.setTimeout(() => {
      setSecondsLeft((prev) => prev - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [showSuccess, secondsLeft, target]);

  if (showSuccess) {
    return (
      <div className="w-full max-w-md space-y-4">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-start gap-3">
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 size-5 text-emerald-500"
              />
              <div className="space-y-1">
                <h1 className="font-medium text-lg">
                  Two-factor authentication enabled
                </h1>
                <p className="text-muted-foreground text-sm">
                  Your account is protected. Your backup codes are saved.
                  Redirecting in {secondsLeft}s, or click Continue to go
                  now.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleContinue}>Continue</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-start gap-3">
            <ShieldAlert
              aria-hidden="true"
              className="mt-0.5 size-5 text-amber-500"
            />
            <div className="space-y-1">
              <h1 className="font-medium text-lg">
                Enable two-factor authentication
              </h1>
              <p className="text-muted-foreground text-sm">
                Two-factor authentication is required on your account. Scan
                the QR with an authenticator app, verify a code, and save
                your backup codes to continue.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      <TotpSetupDialog
        onEnrolled={handleEnrolled}
        onOpenChange={handleOpenChange}
        open={dialogOpen}
      />
    </div>
  );
}
