"use client";

import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { authClient, useSession } from "@/lib/auth-client";

type ChangePasswordSectionProps = {
  providerId: string | null;
};

export function ChangePasswordSection({
  providerId,
}: ChangePasswordSectionProps) {
  const router = useRouter();
  const { closeAll: closeOverlays } = useOverlay();
  const session = useSession();
  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [awaitingEmailOtp, setAwaitingEmailOtp] = useState(false);
  const [loading, setLoading] = useState(false);

  const isOAuthUser = providerId !== null && providerId !== "credential";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    if (totpCode.trim().length !== 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    if (awaitingEmailOtp && emailOtp.trim().length !== 6) {
      toast.error("Enter the 6-digit code we emailed you");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/user/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          code: totpCode.trim(),
          emailOtp: emailOtp.trim() || undefined,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        code?: string;
      };

      if (!response.ok) {
        if (data.code === "factors_required") {
          setAwaitingEmailOtp(true);
          setEmailOtp("");
          toast.success("We just emailed you a confirmation code");
          return;
        }
        if (data.code === "mfa_code_invalid") {
          toast.error(data.error ?? "Invalid authenticator code");
          setTotpCode("");
          return;
        }
        if (data.code === "email_code_invalid") {
          toast.error(data.error ?? "Invalid email code");
          setEmailOtp("");
          return;
        }
        throw new Error(data.error ?? "Failed to change password");
      }

      // Sign out user after password change for security
      await authClient.signOut();
      toast.success("Password changed successfully. Please sign in again.");
      closeOverlays();
      router.push("/");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to change password"
      );
    } finally {
      setLoading(false);
    }
  };

  if (isOAuthUser) {
    const providerName =
      providerId.charAt(0).toUpperCase() + providerId.slice(1);
    return (
      <Card className="border-0 py-0 shadow-none">
        <CardContent className="p-0">
          <div className="space-y-2">
            <Label className="ml-1">Password</Label>
            <p className="text-muted-foreground text-sm">
              Your password is managed by {providerName}. To change your
              password, please visit your {providerName} account settings.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-0 py-0 shadow-none">
      <CardContent className="p-0">
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Alert variant="default">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              You will be signed out after changing your password and will need
              to sign in again.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label className="ml-1" htmlFor="currentPassword">
              Current Password
            </Label>
            <Input
              autoComplete="current-password"
              id="currentPassword"
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              required
              type="password"
              value={currentPassword}
            />
          </div>

          <div className="space-y-2">
            <Label className="ml-1" htmlFor="newPassword">
              New Password
            </Label>
            <Input
              autoComplete="new-password"
              id="newPassword"
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password (min 8 characters)"
              required
              type="password"
              value={newPassword}
            />
          </div>

          <div className="space-y-2">
            <Label className="ml-1" htmlFor="confirmPassword">
              Confirm New Password
            </Label>
            <Input
              autoComplete="new-password"
              id="confirmPassword"
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              required
              type="password"
              value={confirmPassword}
            />
          </div>

          <div className="space-y-2">
            <Label className="ml-1" htmlFor="passwordTotp">
              Authenticator code
            </Label>
            <Input
              autoComplete="one-time-code"
              className="font-mono text-center text-lg tracking-[0.3em]"
              id="passwordTotp"
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
              <Label className="ml-1" htmlFor="passwordEmailOtp">
                Email code
              </Label>
              <Input
                autoComplete="one-time-code"
                className="font-mono text-center text-lg tracking-[0.3em]"
                id="passwordEmailOtp"
                inputMode="numeric"
                maxLength={6}
                onChange={(e) =>
                  setEmailOtp(e.target.value.replace(/\D/g, ""))
                }
                placeholder="000000"
                value={emailOtp}
              />
              <p className="ml-1 text-muted-foreground text-xs">
                We emailed a 6-digit confirmation code. Enter it above
                along with your authenticator code.
              </p>
            </div>
          )}

          <Button
            className="w-full"
            disabled={
              loading ||
              !currentPassword ||
              !newPassword ||
              !confirmPassword ||
              totpCode.trim().length !== 6 ||
              (awaitingEmailOtp && emailOtp.trim().length !== 6)
            }
            type="submit"
          >
            {loading ? <Spinner className="mr-2 size-4" /> : null}
            {awaitingEmailOtp ? "Confirm & Change Password" : "Change Password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
