"use client";

import { useState } from "react";
import { toast } from "sonner";

/**
 * Client-side state + response handler for the dual-factor flow that
 * sits in front of every endpoint guarded by lib/mfa/dual-factor.ts.
 *
 * The endpoint contract is:
 *   - First POST with no codes: server returns 401 + code="factors_required"
 *     and emails a fresh 6-digit code.
 *   - Subsequent POST with both 6-digit codes: server returns 200, or
 *     401 + code="mfa_code_invalid" / "email_code_invalid".
 *
 * The hook owns the three pieces of state every consumer needs
 * (`totpCode`, `emailOtp`, `awaitingEmailOtp`) and a single
 * `handleResponse` that mirrors the server contract: on
 * `factors_required` it flips `awaitingEmailOtp` true, clears the
 * email input, and toasts the user; on either invalid response it
 * clears the offending field and forwards the message to whatever
 * error sink the consumer prefers (toast, local error state, etc).
 *
 * Use with `<DualFactorInput>` from `components/auth/dual-factor-input.tsx`.
 */

export type DualFactorErrorHandler = (message: string) => void;

export type DualFactorHandleOptions = {
  emailSentMessage?: string;
};

export type UseDualFactorState = {
  totpCode: string;
  emailOtp: string;
  awaitingEmailOtp: boolean;
  setTotpCode: (value: string) => void;
  setEmailOtp: (value: string) => void;
  setAwaitingEmailOtp: (value: boolean) => void;
  reset: () => void;
  /**
   * True once enough codes are present to submit: TOTP must be 6
   * digits, and if we are past the first response the email OTP must
   * also be 6 digits.
   */
  isReady: boolean;
  /**
   * Returns true if the response code matched a dual-factor outcome
   * (factors_required / mfa_code_invalid / email_code_invalid) and
   * the hook updated state accordingly. The caller should bail out
   * of its normal success path when this returns true.
   */
  handleResponse: (
    code: string | undefined,
    error: string | undefined,
    onError: DualFactorErrorHandler,
    options?: DualFactorHandleOptions
  ) => boolean;
};

const DEFAULT_EMAIL_SENT_MESSAGE = "We just emailed you a confirmation code";

export function useDualFactorState(): UseDualFactorState {
  const [totpCode, setTotpCode] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [awaitingEmailOtp, setAwaitingEmailOtp] = useState(false);

  const reset = (): void => {
    setTotpCode("");
    setEmailOtp("");
    setAwaitingEmailOtp(false);
  };

  const isReady =
    totpCode.trim().length === 6 &&
    (!awaitingEmailOtp || emailOtp.trim().length === 6);

  const handleResponse: UseDualFactorState["handleResponse"] = (
    code,
    error,
    onError,
    options
  ) => {
    if (code === "factors_required") {
      setAwaitingEmailOtp(true);
      setEmailOtp("");
      toast.success(options?.emailSentMessage ?? DEFAULT_EMAIL_SENT_MESSAGE);
      return true;
    }
    if (code === "mfa_code_invalid") {
      setTotpCode("");
      onError(error ?? "Invalid authenticator code");
      return true;
    }
    if (code === "email_code_invalid") {
      setEmailOtp("");
      onError(error ?? "Invalid email code");
      return true;
    }
    return false;
  };

  return {
    totpCode,
    emailOtp,
    awaitingEmailOtp,
    setTotpCode,
    setEmailOtp,
    setAwaitingEmailOtp,
    reset,
    isReady,
    handleResponse,
  };
}
