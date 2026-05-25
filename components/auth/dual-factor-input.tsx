"use client";

import type { ChangeEvent, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Shared rendering of the dual-factor prompt: a 6-digit
 * authenticator-code input that is always visible, plus a 6-digit
 * email-code input that only appears after the server has emitted
 * `factors_required` (the consumer flips `awaitingEmailOtp` true via
 * the `useDualFactorState` hook).
 *
 * Styling, sanitisation, and microcopy live here so every sensitive
 * surface (withdraw, export-key, api-keys, settings, change-password,
 * deactivate-account) looks and behaves identically.
 */

type Props = {
  /** Used to namespace input ids so multiple instances on a page do not collide. */
  idPrefix: string;
  totpCode: string;
  onTotpChange: (value: string) => void;
  emailOtp: string;
  onEmailOtpChange: (value: string) => void;
  awaitingEmailOtp: boolean;
  totpLabel?: string;
  emailLabel?: string;
  /** Optional help text rendered under the authenticator input. */
  totpHelp?: ReactNode;
  /**
   * Optional override for the standard help text rendered under the
   * email input. Defaults to the standard "We emailed a 6-digit
   * confirmation code." line.
   */
  emailHelp?: ReactNode;
  autoFocusTotp?: boolean;
  disabled?: boolean;
};

const INPUT_CLASSES = "font-mono text-center text-lg tracking-[0.3em]";
const DEFAULT_EMAIL_HELP =
  "We emailed a 6-digit confirmation code. Enter it above along with your authenticator code.";

const numericOnly = (value: string): string => value.replace(/\D/g, "");

export function DualFactorInput({
  idPrefix,
  totpCode,
  onTotpChange,
  emailOtp,
  onEmailOtpChange,
  awaitingEmailOtp,
  totpLabel = "Authenticator code",
  emailLabel = "Email code",
  totpHelp,
  emailHelp,
  autoFocusTotp,
  disabled,
}: Props): React.ReactElement {
  const totpId = `${idPrefix}-totp`;
  const emailId = `${idPrefix}-email-otp`;

  const handleTotp = (event: ChangeEvent<HTMLInputElement>): void => {
    onTotpChange(numericOnly(event.target.value));
  };
  const handleEmail = (event: ChangeEvent<HTMLInputElement>): void => {
    onEmailOtpChange(numericOnly(event.target.value));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={totpId}>{totpLabel}</Label>
        <Input
          autoComplete="one-time-code"
          autoFocus={autoFocusTotp === true && !awaitingEmailOtp}
          className={INPUT_CLASSES}
          disabled={disabled}
          id={totpId}
          inputMode="numeric"
          maxLength={6}
          onChange={handleTotp}
          placeholder="000000"
          value={totpCode}
        />
        {totpHelp && (
          <p className="text-muted-foreground text-xs">{totpHelp}</p>
        )}
      </div>
      {awaitingEmailOtp && (
        <div className="space-y-2">
          <Label htmlFor={emailId}>{emailLabel}</Label>
          <Input
            autoComplete="one-time-code"
            autoFocus
            className={INPUT_CLASSES}
            disabled={disabled}
            id={emailId}
            inputMode="numeric"
            maxLength={6}
            onChange={handleEmail}
            placeholder="000000"
            value={emailOtp}
          />
          <p className="text-muted-foreground text-xs">
            {emailHelp ?? DEFAULT_EMAIL_HELP}
          </p>
        </div>
      )}
    </div>
  );
}
