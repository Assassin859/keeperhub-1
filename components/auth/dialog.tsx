"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { authClient, signIn, signUp } from "@/lib/auth-client";
import { AUTH_SUCCESS_EVENT } from "@/lib/auth-events";
import {
  getEnabledAuthProviders,
  getSingleProvider,
} from "@/lib/auth-providers";
import { setPendingClaim } from "@/lib/hooks/use-claim-workflow";
import { refetchOrganizations } from "@/lib/refetch-organizations";

const WORKFLOW_PATH_REGEX = /^\/workflows\/([^/]+)$/;

export type AuthPromptIntent = {
  action?: string;
  redirectTo?: string;
};

type AuthDialogProps = {
  children?: ReactNode;
  /**
   * When provided, AuthDialog is in controlled mode: this prop drives the
   * open state and `onControlledOpenChange` is invoked on every change.
   * When absent, AuthDialog uses internal useState as today.
   * Used by AuthProvider/useAuthPrompt for programmatic open.
   */
  controlledOpen?: boolean;
  onControlledOpenChange?: (open: boolean) => void;
  /**
   * Optional intent payload — telemetry/analytics hint and post-sign-in
   * redirect bias. Not consumed by the modal copy itself.
   * Phase 43 will read `redirectTo` after OAuth callback.
   */
  intent?: AuthPromptIntent;
};

type ModalView =
  | "signin"
  | "signup"
  | "verify"
  | "signin-email-otp"
  | "totp"
  | "forgot-password"
  | "reset-password";

const GitHubIcon = () => (
  <svg
    aria-label="GitHub"
    className="mr-2 h-4 w-4"
    fill="currentColor"
    role="img"
    viewBox="0 0 24 24"
  >
    <title>GitHub</title>
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

const GoogleIcon = () => (
  <svg
    aria-label="Google"
    className="mr-2 h-4 w-4"
    role="img"
    viewBox="0 0 24 24"
  >
    <title>Google</title>
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="currentColor"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="currentColor"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      fill="currentColor"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      fill="currentColor"
    />
  </svg>
);

type Provider = "email" | "github" | "google";

const getProviderIcon = (provider: Provider, compact = false) => {
  const _iconClass = compact ? "size-3.5" : undefined;
  switch (provider) {
    case "github":
      return <GitHubIcon />;
    case "google":
      return <GoogleIcon />;
    default:
      return null;
  }
};

const getProviderLabel = (provider: Provider) => {
  switch (provider) {
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    default:
      return "Email";
  }
};

// Social buttons component
type SocialButtonsProps = {
  enabledProviders: { github: boolean; google: boolean };
  onSignIn: (provider: "github" | "google") => void;
  loadingProvider: "github" | "google" | null;
};

const SocialButtons = ({
  enabledProviders,
  onSignIn,
  loadingProvider,
}: SocialButtonsProps) => (
  <div className="flex flex-col gap-2">
    {enabledProviders.github && (
      <Button
        className="w-full"
        disabled={loadingProvider !== null}
        onClick={() => onSignIn("github")}
        type="button"
        variant="outline"
      >
        <GitHubIcon />
        {loadingProvider === "github" ? "Loading..." : "Continue with GitHub"}
      </Button>
    )}
    {enabledProviders.google && (
      <Button
        className="w-full"
        disabled={loadingProvider !== null}
        onClick={() => onSignIn("google")}
        type="button"
        variant="outline"
      >
        <GoogleIcon />
        {loadingProvider === "google" ? "Loading..." : "Continue with Google"}
      </Button>
    )}
  </div>
);

// Sign In Form
type SignInFormProps = {
  email: string;
  password: string;
  error: string;
  loading: boolean;
  onEmailChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCreateAccount: () => void;
  onForgotPassword: () => void;
};

const SignInForm = ({
  email,
  password,
  error,
  loading,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onCreateAccount,
  onForgotPassword,
}: SignInFormProps) => (
  <div className="space-y-4">
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="email">
          Email
        </Label>
        <Input
          id="email"
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={email}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="ml-1" htmlFor="password">
            Password
          </Label>
          <button
            className="text-muted-foreground text-xs hover:text-foreground"
            onClick={onForgotPassword}
            tabIndex={-1}
            type="button"
          >
            Forgot password?
          </button>
        </div>
        <Input
          id="password"
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="Enter your password"
          required
          type="password"
          value={password}
        />
      </div>
      {error && <div className="text-destructive text-sm">{error}</div>}
      <Button className="w-full" disabled={loading} type="submit">
        {loading ? <Spinner className="mr-2 size-4" /> : null}
        Sign in
      </Button>
    </form>
    <div className="flex items-center justify-center gap-1 text-sm">
      <span className="text-muted-foreground">New here?</span>
      <button
        className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
        onClick={onCreateAccount}
        type="button"
      >
        Create account
      </button>
    </div>
  </div>
);

// Single provider button
let singleProviderSignInInitiated = false;
export const isSingleProviderSignInInitiated = () =>
  singleProviderSignInInitiated;

// Track verification state to persist through component remounts
let pendingVerifyEmail: string | null = null;
let pendingVerifyPassword: string | null = null;

type SingleProviderButtonProps = {
  provider: Provider;
  loadingProvider: "github" | "google" | null;
  onSignIn: (provider: "github" | "google") => Promise<void>;
};

const SingleProviderButton = ({
  provider,
  loadingProvider,
  onSignIn,
}: SingleProviderButtonProps) => {
  const [isInitiated, setIsInitiated] = useState(singleProviderSignInInitiated);
  const isLoading = loadingProvider === provider || isInitiated;

  const handleClick = () => {
    singleProviderSignInInitiated = true;
    setIsInitiated(true);
    onSignIn(provider as "github" | "google");
  };

  return (
    <Button
      className="h-9 gap-1.5 px-2 disabled:opacity-100 sm:px-3"
      disabled={isLoading}
      onClick={handleClick}
      size="sm"
      variant="default"
    >
      {isLoading ? (
        <Spinner className="size-3.5" />
      ) : (
        getProviderIcon(provider, true)
      )}
      <span className="text-sm">Sign In</span>
    </Button>
  );
};

// Helper functions
const getViewTitle = (view: ModalView) => {
  switch (view) {
    case "signin":
      return "Sign in";
    case "signup":
      return "Create account";
    case "verify":
      return "Verify your email";
    case "signin-email-otp":
      return "Check your email";
    case "totp":
      return "Confirm with your authenticator";
    case "forgot-password":
      return "Reset password";
    case "reset-password":
      return "Set new password";
    default:
      return "Sign in";
  }
};

const getViewDescription = (view: ModalView, email?: string) => {
  switch (view) {
    case "signin":
      return "Sign in to your account to continue.";
    case "signup":
      return "Create your account to get started.";
    case "verify":
      return email
        ? `Enter the 6-digit code sent to ${email}`
        : "Enter the verification code sent to your email.";
    case "signin-email-otp":
      return email
        ? `Enter the 6-digit code emailed to ${email}. After this we'll ask for your authenticator code.`
        : "Enter the 6-digit code emailed to you. After this we'll ask for your authenticator code.";
    case "totp":
      return "Enter the current 6-digit code from your authenticator app to finish signing in.";
    case "forgot-password":
      return "Enter your email to receive a password reset code.";
    case "reset-password":
      return email
        ? `Enter the 6-digit code sent to ${email} and your new password.`
        : "Enter the reset code and your new password.";
    default:
      return null;
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Auth dialog handles multiple views and flows
export const AuthDialog = ({
  children,
  controlledOpen,
  onControlledOpenChange,
  // intent prop is intentionally accepted but not yet wired to flow
  // (Phase 43 reads redirectTo from the AuthPromptProvider's stored intent
  // after OAuth callback). Accept-and-ignore here is the locked contract.
  // biome-ignore lint/correctness/noUnusedFunctionParameters: forward-compat
  intent: _intent,
}: AuthDialogProps) => {
  // Internal state — used when not controlled. We always call useState to
  // keep hook order stable; the value is just ignored when controlled.
  const [internalOpen, setInternalOpen] = useState(
    () => pendingVerifyEmail !== null
  );

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) {
      onControlledOpenChange?.(next);
    } else {
      setInternalOpen(next);
    }
  };
  const router = useRouter();
  const [view, setView] = useState<ModalView>(() =>
    pendingVerifyEmail === null ? "signin" : "verify"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verifyEmail, setVerifyEmail] = useState(
    () => pendingVerifyEmail || ""
  );
  const [verifyPassword, setVerifyPassword] = useState(
    () => pendingVerifyPassword || ""
  );
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  // Optional second factor on the password-reset path. Server only
  // requires it when the target user has TOTP enrolled; we ask for
  // it preemptively so the user doesn't have to round-trip.
  const [forgotTotp, setForgotTotp] = useState("");
  const [forgotNeedsMfa, setForgotNeedsMfa] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [loadingProvider, setLoadingProvider] = useState<
    "github" | "google" | null
  >(null);

  // Handle pending verification when component mounts/remounts
  // Do NOT clear pendingVerify* here - they must survive remounts caused by
  // session refetch on tab focus. They are cleared on successful verification
  // (handleVerifyOtp) or when the user navigates away (Back to sign in).
  useEffect(() => {
    if (pendingVerifyEmail) {
      setOpen(true);
      setView("verify");
      setVerifyEmail(pendingVerifyEmail);
      if (pendingVerifyPassword) {
        setVerifyPassword(pendingVerifyPassword);
      }
    }
  }, []);

  const enabledProviders = getEnabledAuthProviders();
  const singleProvider = getSingleProvider();
  const hasSocialProviders = enabledProviders.github || enabledProviders.google;

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setVerifyEmail("");
    setVerifyPassword("");
    setOtp("");
    setError("");
    setForgotEmail("");
    setNewPassword("");
    setConfirmNewPassword("");
    setForgotTotp("");
    setForgotNeedsMfa(false);
  };

  const getClaimContext = async () => {
    const workflowMatch = window.location.pathname.match(WORKFLOW_PATH_REGEX);
    if (!workflowMatch) {
      return null;
    }
    const currentSession = await authClient.getSession();
    const previousUserId = currentSession?.data?.user?.id;
    if (!previousUserId) {
      return null;
    }
    return { workflowId: workflowMatch[1], previousUserId };
  };

  const storeClaimIfNeeded = (
    claimContext: { workflowId: string; previousUserId: string } | null
  ) => {
    if (claimContext) {
      setPendingClaim(claimContext);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      pendingVerifyEmail = null;
      pendingVerifyPassword = null;
      setTimeout(() => {
        setView("signin");
        resetForm();
      }, 200);
    }
  };

  const handleSocialSignIn = async (provider: "github" | "google") => {
    try {
      setLoadingProvider(provider);
      const claimContext = await getClaimContext();
      storeClaimIfNeeded(claimContext);
      await signIn.social({ provider, callbackURL: window.location.pathname });
    } catch {
      toast.error(`Failed to sign in with ${getProviderLabel(provider)}`);
      setLoadingProvider(null);
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex auth flow with multiple verification paths
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const claimContext = await getClaimContext();

    try {
      // Strict atomic dual-factor sign-in:
      //   /strict-signin/start validates the password against the
      //   credential account directly (no Better Auth session minted)
      //   and triggers the email-OTP send. The user then provides the
      //   email OTP and TOTP across the next two dialog steps, and
      //   /api/auth/strict-signin verifies all three factors before
      //   any session is created. Better Auth's signIn.email is NOT
      //   called from the dialog because that path leaves a
      //   two_factor cookie that the standalone signIn.emailOtp path
      //   can convert into a session without TOTP.
      const startResponse = await fetch("/api/auth/strict-signin/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const startBody = (await startResponse.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        signedIn?: boolean;
      };
      if (!startResponse.ok) {
        setError(startBody.error ?? "Sign in failed");
        return;
      }
      storeClaimIfNeeded(claimContext);
      // Users without TOTP enrolled get a session minted directly by
      // /strict-signin/start; the response carries the session cookies
      // and we hard-reload to pick them up. Users with TOTP enrolled
      // get signedIn=false and proceed to the email-OTP step.
      if (startBody.signedIn) {
        toast.success("Signed in successfully!");
        window.dispatchEvent(new CustomEvent(AUTH_SUCCESS_EVENT));
        if (typeof window !== "undefined") {
          window.location.assign("/");
        }
        return;
      }
      setOtp("");
      setVerifyEmail(email);
      setView("signin-email-otp");
      setLoading(false);
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setLoading(false);
    }
  };

  /**
   * Re-send the sign-in email OTP from the same email-otp view.
   * Mirrors authClient.emailOtp.sendVerificationOtp call we make in
   * handleSignIn so the user can rerequest without bouncing back to
   * the password screen.
   */
  const handleResendSigninEmailOtp = async (): Promise<void> => {
    const targetEmail = verifyEmail || email;
    if (!targetEmail) {
      setError("Missing email, start sign-in again");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const sendResult = await authClient.emailOtp.sendVerificationOtp({
        email: targetEmail,
        type: "sign-in",
      });
      if (sendResult.error) {
        setError(sendResult.error.message ?? "Failed to resend code");
        return;
      }
      toast.success("Code resent");
      setOtp("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend code");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Submit the email OTP that finishes the FIRST factor of a
   * mandatory dual-factor sign-in (password → email → TOTP). Calls
   * signIn.emailOtp; for users with TOTP enrolled Better Auth then
   * returns twoFactorRedirect again, which routes us to the totp
   * view. Users without TOTP (shouldn't exist under the mandate, but
   * defensive) would get a fully-signed-in session here.
   */
  const handleSigninEmailOtp = (e: React.FormEvent): void => {
    e.preventDefault();
    if (otp.trim().length !== 6) {
      setError("Enter the 6-digit code from your email");
      return;
    }
    // Strict atomic dual-factor: do NOT verify the email OTP here.
    // Hold onto it (already in `otp` state) and move to the TOTP
    // step. The atomic /api/auth/strict-signin endpoint will verify
    // email OTP and TOTP together, mint the session only if both
    // pass, and reject otherwise. Verifying email OTP separately at
    // this step would either bypass TOTP (the security bug we're
    // fixing) or require holding partial state on the server.
    setError("");
    setTotpCode("");
    setView("totp");
  };

  /**
   * Submit the TOTP code that finishes a sign-in that paused on
   * Better Auth's twoFactorRedirect step. The plugin's verifyTotp
   * endpoint converts the `better-auth.two_factor` challenge cookie
   * into a real session cookie on success.
   */
  const handleTotpVerify = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (totpCode.trim().length !== 6) {
      setError("Enter the 6-digit code from your authenticator");
      return;
    }
    if (otp.trim().length !== 6) {
      setError("Missing email code. Start sign-in again.");
      setView("signin");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const completeResponse = await fetch("/api/auth/strict-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: verifyEmail || email,
          password,
          emailOtp: otp.trim(),
          totpCode: totpCode.trim(),
        }),
      });
      const completeBody = (await completeResponse
        .json()
        .catch(() => ({}))) as { error?: string; code?: string };
      if (!completeResponse.ok) {
        if (completeBody.code === "invalid_email_otp") {
          setError("Invalid email code");
          setOtp("");
          setView("signin-email-otp");
          return;
        }
        if (completeBody.code === "invalid_totp") {
          setError("Invalid authenticator code");
          setTotpCode("");
          return;
        }
        setError(completeBody.error ?? "Sign in failed");
        return;
      }
      toast.success("Signed in successfully!");
      setTotpCode("");
      setOtp("");
      window.dispatchEvent(new CustomEvent(AUTH_SUCCESS_EVENT));
      // Hard reload so the server re-renders with the new
      // better-auth.session_token cookie. authClient.getSession()
      // does refresh the atom but the user-menu/useSession subtree
      // races the AuthDialog unmount that happens once the dialog
      // closes; the cleanest signal is a real navigation.
      if (typeof window !== "undefined") {
        window.location.assign("/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles signup with unverified user detection
  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const signUpResponse = await signUp.email({
        email,
        password,
        name: email.split("@")[0],
      });

      if (signUpResponse.error) {
        const errorMsg = signUpResponse.error.message || "Sign up failed";

        // Check if error is about existing user (might be unverified)
        if (
          errorMsg.toLowerCase().includes("already") ||
          errorMsg.toLowerCase().includes("exists") ||
          errorMsg.toLowerCase().includes("duplicate")
        ) {
          // Try to send verification OTP - if user exists but unverified, this will work
          try {
            const otpResponse = await authClient.emailOtp.sendVerificationOtp({
              email,
              type: "email-verification",
            });

            if (otpResponse.error) {
              // OTP send failed due to API error
              const otpErrMsg =
                otpResponse.error.message || "Failed to send verification code";
              toast.error(otpErrMsg);
              setError(
                "An account with this email already exists. Please sign in."
              );
              setLoading(false);
              return;
            }

            // OTP sent successfully - user exists but is unverified
            setVerifyEmail(email);
            setVerifyPassword(password);
            setView("verify");
            setOtp("");
            pendingVerifyEmail = email;
            pendingVerifyPassword = password;

            toast.info(
              "An account with this email already exists. Please verify your email.",
              { duration: 5000 }
            );
            setLoading(false);
            return;
          } catch (otpErr) {
            // OTP send failed - user is already verified or email send failed
            const otpErrMsg =
              otpErr instanceof Error
                ? otpErr.message
                : "Failed to send verification code";
            if (otpErrMsg.toLowerCase().includes("email")) {
              toast.error(otpErrMsg);
            }
            setError(
              "An account with this email already exists. Please sign in."
            );
            setLoading(false);
            return;
          }
        }

        setError(errorMsg);
        setLoading(false);
        return;
      }

      // Store email and password for verification view
      const signedUpEmail = email;
      const signedUpPassword = password;

      // Switch to verify view
      setLoading(false);
      setVerifyEmail(signedUpEmail);
      setVerifyPassword(signedUpPassword);
      setView("verify");
      setError("");
      setOtp("");

      // Store in module-level vars in case component remounts
      pendingVerifyEmail = signedUpEmail;
      pendingVerifyPassword = signedUpPassword;

      toast.success(
        `Verification code sent to ${signedUpEmail}. Please check your inbox.`,
        { duration: 5000 }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    // Capture claim context BEFORE verification (while still anonymous)
    const claimContext = await getClaimContext();

    try {
      const response = await authClient.emailOtp.verifyEmail({
        email: verifyEmail,
        otp,
      });

      if (response.error) {
        setError(response.error.message || "Verification failed");
        setLoading(false);
        return;
      }

      // Clear pending state
      pendingVerifyEmail = null;
      pendingVerifyPassword = null;

      // Auto sign-in after verification using stored password
      if (verifyPassword) {
        const signInResponse = await signIn.email({
          email: verifyEmail,
          password: verifyPassword,
        });

        if (signInResponse.error) {
          // Verification succeeded but sign-in failed - redirect to sign in
          toast.success("Email verified! Please sign in.");
          setView("signin");
          setEmail(verifyEmail);
          setPassword("");
          setOtp("");
          setLoading(false);
          return;
        }
      }

      // Store claim context after successful sign-in
      storeClaimIfNeeded(claimContext);

      // Refresh session
      await authClient.getSession();
      refetchOrganizations();

      toast.success("Email verified! You're now signed in.");
      setOpen(false);
      resetForm();
      window.dispatchEvent(new CustomEvent(AUTH_SUCCESS_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setError("");
    setLoading(true);

    try {
      const response = await authClient.emailOtp.sendVerificationOtp({
        email: verifyEmail,
        type: "email-verification",
      });

      if (response.error) {
        const errorMsg = response.error.message || "Failed to resend code";
        setError(errorMsg);
        toast.error(errorMsg);
        setLoading(false);
        return;
      }

      toast.success("New verification code sent!");
      setLoading(false);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to resend code";
      setError(errorMsg);
      toast.error(errorMsg);
      setLoading(false);
    }
  };

  const handleForgotPasswordRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/user/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email: forgotEmail }),
      });

      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to send reset code");
      }

      toast.success("If an account exists, a reset code has been sent.");
      setView("reset-password");
      setOtp("");
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to send reset code";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmNewPassword) {
      setError("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/user/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset",
          email: forgotEmail,
          otp,
          newPassword,
          code: forgotTotp ? forgotTotp.trim() : undefined,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        code?: string;
      };

      if (!response.ok) {
        // Server signaled the user has TOTP enrolled: reveal the
        // code field and let them retry without losing the OTP /
        // password they already typed.
        if (data.code === "mfa_code_required") {
          setForgotNeedsMfa(true);
          setError(
            data.error ??
              "This account has two-factor enabled. Enter a code from your authenticator."
          );
          return;
        }
        if (data.code === "mfa_code_invalid") {
          setForgotTotp("");
          setError(data.error ?? "Invalid verification code");
          return;
        }
        throw new Error(data.error ?? "Failed to reset password");
      }

      toast.success("Password reset successfully! Please sign in.");
      setView("signin");
      setEmail(forgotEmail);
      resetForm();
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to reset password";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleResendForgotOtp = async () => {
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/user/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email: forgotEmail }),
      });

      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to resend code");
      }

      toast.success("New reset code sent!");
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to resend code";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  if (singleProvider && singleProvider !== "email") {
    return (
      <SingleProviderButton
        loadingProvider={loadingProvider}
        onSignIn={handleSocialSignIn}
        provider={singleProvider}
      />
    );
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      {!isControlled && (
        <DialogTrigger asChild>
          {children || (
            <Button size="sm" variant="default">
              Sign In
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{getViewTitle(view)}</DialogTitle>
          {getViewDescription(view, verifyEmail) && (
            <DialogDescription>
              {getViewDescription(view, verifyEmail)}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          {view === "signin" && (
            <>
              {hasSocialProviders && enabledProviders.email && (
                <>
                  <SocialButtons
                    enabledProviders={enabledProviders}
                    loadingProvider={loadingProvider}
                    onSignIn={handleSocialSignIn}
                  />
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <Separator />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">
                        Or continue with email
                      </span>
                    </div>
                  </div>
                </>
              )}
              {hasSocialProviders && !enabledProviders.email && (
                <SocialButtons
                  enabledProviders={enabledProviders}
                  loadingProvider={loadingProvider}
                  onSignIn={handleSocialSignIn}
                />
              )}
              {enabledProviders.email && (
                <SignInForm
                  email={email}
                  error={error}
                  loading={loading}
                  onCreateAccount={() => {
                    setView("signup");
                    setError("");
                  }}
                  onEmailChange={setEmail}
                  onForgotPassword={() => {
                    setForgotEmail(email);
                    setView("forgot-password");
                    setError("");
                  }}
                  onPasswordChange={setPassword}
                  onSubmit={handleSignIn}
                  password={password}
                />
              )}
            </>
          )}

          {view === "signup" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handleSignUp}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="signup-email">
                    Email
                  </Label>
                  <Input
                    id="signup-email"
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    type="email"
                    value={email}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="signup-password">
                    Password
                  </Label>
                  <Input
                    id="signup-password"
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a password"
                    required
                    type="password"
                    value={password}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button className="w-full" disabled={loading} type="submit">
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Create account
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <span className="text-muted-foreground">
                  Already have an account?
                </span>
                <button
                  className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                  }}
                  type="button"
                >
                  Sign in
                </button>
              </div>
            </div>
          )}

          {view === "verify" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handleVerifyOtp}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="otp">
                    Verification Code
                  </Label>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    className="text-center font-mono text-2xl tracking-[0.5em]"
                    id="otp"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    pattern="[0-9]*"
                    placeholder="000000"
                    required
                    value={otp}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button
                  className="w-full"
                  disabled={loading || otp.length !== 6}
                  type="submit"
                >
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Verify
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <span className="text-muted-foreground">
                  Didn't receive the code?
                </span>
                <button
                  className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                  disabled={loading}
                  onClick={handleResendOtp}
                  type="button"
                >
                  Resend
                </button>
              </div>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                    setOtp("");
                    pendingVerifyEmail = null;
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}

          {view === "signin-email-otp" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handleSigninEmailOtp}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="signin-email-otp-input">
                    Email code
                  </Label>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    className="text-center font-mono text-2xl tracking-[0.5em]"
                    id="signin-email-otp-input"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    pattern="[0-9]*"
                    placeholder="000000"
                    required
                    value={otp}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button
                  className="w-full"
                  disabled={loading || otp.length !== 6}
                  type="submit"
                >
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Continue
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <span className="text-muted-foreground">
                  Didn't receive your code?
                </span>
                <button
                  className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                  disabled={loading}
                  onClick={handleResendSigninEmailOtp}
                  type="button"
                >
                  Resend email
                </button>
              </div>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                    setOtp("");
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}

          {view === "totp" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handleTotpVerify}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="signin-totp">
                    Authenticator code
                  </Label>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    className="text-center font-mono text-2xl tracking-[0.5em]"
                    id="signin-totp"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) =>
                      setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    pattern="[0-9]*"
                    placeholder="000000"
                    required
                    value={totpCode}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button
                  className="w-full"
                  disabled={loading || totpCode.length !== 6}
                  type="submit"
                >
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Verify
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                    setTotpCode("");
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}

          {view === "forgot-password" && (
            <div className="space-y-4">
              <form
                className="space-y-4"
                onSubmit={handleForgotPasswordRequest}
              >
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="forgot-email">
                    Email
                  </Label>
                  <Input
                    autoFocus
                    id="forgot-email"
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    type="email"
                    value={forgotEmail}
                  />
                </div>
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button className="w-full" disabled={loading} type="submit">
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Send Reset Code
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}

          {view === "reset-password" && (
            <div className="space-y-4">
              <form className="space-y-4" onSubmit={handlePasswordReset}>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="reset-otp">
                    Reset Code
                  </Label>
                  <Input
                    autoComplete="one-time-code"
                    autoFocus
                    className="text-center font-mono text-2xl tracking-[0.5em]"
                    id="reset-otp"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    pattern="[0-9]*"
                    placeholder="000000"
                    required
                    value={otp}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="new-password">
                    New Password
                  </Label>
                  <Input
                    autoComplete="new-password"
                    id="new-password"
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password (min 8 characters)"
                    required
                    type="password"
                    value={newPassword}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="confirm-new-password">
                    Confirm New Password
                  </Label>
                  <Input
                    autoComplete="new-password"
                    id="confirm-new-password"
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirm new password"
                    required
                    type="password"
                    value={confirmNewPassword}
                  />
                </div>
                {forgotNeedsMfa && (
                  <div className="space-y-2">
                    <Label className="ml-1" htmlFor="forgot-totp">
                      Authenticator code
                    </Label>
                    <Input
                      autoComplete="one-time-code"
                      className="text-center font-mono text-2xl tracking-[0.5em]"
                      id="forgot-totp"
                      inputMode="numeric"
                      maxLength={6}
                      onChange={(e) =>
                        setForgotTotp(
                          e.target.value.replace(/\D/g, "").slice(0, 6)
                        )
                      }
                      pattern="[0-9]*"
                      placeholder="000000"
                      required
                      value={forgotTotp}
                    />
                    <p className="text-muted-foreground text-xs">
                      Your account has two-factor enabled. Enter the current
                      code from your authenticator app.
                    </p>
                  </div>
                )}
                {error && (
                  <div className="text-destructive text-sm">{error}</div>
                )}
                <Button
                  className="w-full"
                  disabled={
                    loading ||
                    otp.length !== 6 ||
                    !newPassword ||
                    !confirmNewPassword
                  }
                  type="submit"
                >
                  {loading ? <Spinner className="mr-2 size-4" /> : null}
                  Reset Password
                </Button>
              </form>
              <div className="flex items-center justify-center gap-1 text-sm">
                <span className="text-muted-foreground">
                  Didn't receive the code?
                </span>
                <button
                  className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                  disabled={loading}
                  onClick={handleResendForgotOtp}
                  type="button"
                >
                  Resend
                </button>
              </div>
              <div className="flex items-center justify-center gap-1 text-sm">
                <button
                  className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground/80"
                  onClick={() => {
                    setView("signin");
                    setError("");
                    setOtp("");
                    setNewPassword("");
                    setConfirmNewPassword("");
                  }}
                  type="button"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
