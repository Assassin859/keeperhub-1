"use client";

import { ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Card, CardContent } from "@/components/ui/card";

type Props = {
  next: string;
};

/**
 * Forced enrollment surface. The page is reached only when
 * users.two_factor_enabled = false; the proxy keeps redirecting here
 * until that flips to true. Dismissal is intentionally not wired —
 * onOpenChange is a no-op so the wizard stays mounted regardless of
 * Escape / backdrop / close-button events. Successful enrollment
 * triggers a hard reload to the original target so the proxy re-reads
 * the updated session and the redirect lifts.
 */
export function EnrollMfaForm({ next }: Props): React.ReactElement {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(true);

  const handleEnrolled = (): void => {
    setDialogOpen(false);
    // Hard reload so the server-rendered shell picks up the new
    // two_factor_enabled state and the proxy stops redirecting.
    window.location.assign(next || "/");
  };

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
        onOpenChange={() => {
          // No-op: the wizard cannot be dismissed from this surface.
        }}
        open={dialogOpen}
      />
    </div>
  );
}
