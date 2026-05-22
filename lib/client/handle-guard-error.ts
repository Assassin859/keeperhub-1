"use client";

import { toast } from "sonner";

/**
 * Server-side guard error codes returned by the helpers in
 * lib/middleware/owner-mfa-guard.ts. Mirrored here so the client can
 * branch UX without parsing error strings.
 */
export type GuardErrorCode =
  | "not_owner"
  | "not_admin_or_owner"
  | "mfa_not_enrolled"
  | "mfa_pending";

export type GuardErrorBody = {
  error?: string;
  code?: GuardErrorCode | string;
};

type Handlers = {
  /**
   * Called when the server says the user must enroll TOTP before
   * doing this action. The callsite typically opens Settings -> Security
   * (where the TwoFactorSection lives) so the user can take action
   * from the toast.
   */
  onEnrollMfa?: () => void;
  /**
   * Called when the server says the session is flagged by login-risk
   * detection and step-up has not been completed. The callsite
   * typically routes to /verify-mfa, optionally with a `next` query.
   */
  onPendingMfa?: (currentPath: string) => void;
};

/**
 * Reads a 403 response from one of the gated routes and dispatches
 * the right UX. Returns true if the response was a guard error this
 * helper handled (the caller should stop, not throw or display its
 * own error). Returns false otherwise, so the caller falls through to
 * its existing error path.
 *
 * Server contract is the discriminated GuardError shape defined in
 * lib/middleware/owner-mfa-guard.ts. Anything outside that contract
 * (5xx, 400 validation errors, plain 403 without a code) is left to
 * the caller.
 */
export async function handleGuardError(
  response: Response,
  handlers: Handlers = {}
): Promise<boolean> {
  if (response.status !== 403) {
    return false;
  }
  let body: GuardErrorBody;
  try {
    body = (await response.clone().json()) as GuardErrorBody;
  } catch {
    return false;
  }
  const code = body.code;
  if (code === "mfa_not_enrolled") {
    toast.error(
      body.error ??
        "Enable two-factor authentication on your account before this action."
    );
    handlers.onEnrollMfa?.();
    return true;
  }
  if (code === "mfa_pending") {
    toast.error(
      body.error ?? "Verify your second factor to continue this action."
    );
    const currentPath =
      typeof window === "undefined"
        ? "/"
        : window.location.pathname + window.location.search;
    handlers.onPendingMfa?.(currentPath);
    return true;
  }
  if (code === "not_owner") {
    toast.error(
      body.error ??
        "Only an organization owner can perform this action. Ask the org owner to do it."
    );
    return true;
  }
  if (code === "not_admin_or_owner") {
    toast.error(
      body.error ??
        "Only organization admins and owners can perform this action."
    );
    return true;
  }
  return false;
}
