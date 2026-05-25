"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DualFactorInput } from "@/components/auth/dual-factor-input";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { authClient, useSession } from "@/lib/auth-client";

export function DeactivateAccountSection() {
  const router = useRouter();
  const { closeAll: closeOverlays } = useOverlay();
  const session = useSession();
  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;
  const [confirmation, setConfirmation] = useState("");
  const dual = useDualFactorState();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const handleDeactivate = async (): Promise<void> => {
    if (confirmation !== "DEACTIVATE") {
      toast.error("Please type DEACTIVATE to confirm");
      return;
    }
    if (dual.totpCode.trim().length !== 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    if (dual.awaitingEmailOtp && dual.emailOtp.trim().length !== 6) {
      toast.error("Enter the 6-digit code we emailed you");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/user/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation,
          code: dual.totpCode.trim(),
          emailOtp: dual.emailOtp.trim() || undefined,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        code?: string;
      };

      if (!response.ok) {
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        throw new Error(data.error ?? "Failed to deactivate account");
      }

      await authClient.signOut();
      toast.success("Account deactivated successfully");
      setOpen(false);
      closeOverlays();
      router.push("/");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to deactivate account"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-destructive/50 py-0 shadow-none">
      <CardContent className="p-4">
        <div className="space-y-4">
          <div>
            <h3 className="font-medium text-destructive">Deactivate Account</h3>
            <p className="mt-1 text-muted-foreground text-sm">
              Deactivate your account. You will be signed out and unable to sign
              in until the account is reactivated.
            </p>
          </div>

          <AlertDialog onOpenChange={setOpen} open={open}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Deactivate Account</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Deactivate your account?</AlertDialogTitle>
                <AlertDialogDescription>
                  Your account will be deactivated and you will be signed out.
                  Your data will be preserved, but you will not be able to sign
                  in until the account is reactivated by an administrator.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="deactivateConfirmation">
                    Type{" "}
                    <span className="font-mono font-semibold">DEACTIVATE</span>{" "}
                    to confirm
                  </Label>
                  <Input
                    autoComplete="off"
                    id="deactivateConfirmation"
                    onChange={(e) => setConfirmation(e.target.value)}
                    placeholder="DEACTIVATE"
                    value={confirmation}
                  />
                </div>
                <DualFactorInput
                  awaitingEmailOtp={dual.awaitingEmailOtp}
                  emailOtp={dual.emailOtp}
                  idPrefix="deactivate"
                  onEmailOtpChange={dual.setEmailOtp}
                  onTotpChange={dual.setTotpCode}
                  totpCode={dual.totpCode}
                />
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel
                  onClick={() => {
                    setConfirmation("");
                    dual.reset();
                  }}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={
                    confirmation !== "DEACTIVATE" || loading || !dual.isReady
                  }
                  onClick={(e) => {
                    e.preventDefault();
                    handleDeactivate();
                  }}
                >
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  {dual.awaitingEmailOtp
                    ? "Confirm Deactivation"
                    : "Deactivate Account"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
