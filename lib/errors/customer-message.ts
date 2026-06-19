import { getCustomerMessageForCode } from "@/lib/errors/error-codes";
import type { ErrorCategory } from "@/lib/logging";

/**
 * Maps a finished workflow run's failure fields to a short, customer-readable
 * message for the run logs UI, or null when the run did not fail.
 *
 * For system failures it prefers the stable, not-overly-revealing message keyed
 * by the run's `error_code` (PREFIX-NNNN); it surfaces the raw error only for
 * user-config failures, which are actionable by the workflow author. Legacy
 * rows without a code fall back to the prior generic messages.
 *
 * Kept free of value imports from `@/lib/logging` (which pulls in Sentry and
 * metrics) so it is safe to use in client components; `@/lib/errors/error-codes`
 * is likewise client-safe (it only type-imports `ErrorCategory`).
 */
type RunErrorInput = {
  status: string;
  error: string | null;
  errorType: "user" | "system" | null;
  errorCategory: ErrorCategory | string | null;
  errorCode?: string | null;
};

export function getCustomerRunErrorMessage(run: RunErrorInput): string | null {
  // KEEP-853: system failures carry status='system_error'; they are exactly the
  // coded runs whose customer message lives in the registry, so include them.
  if (run.status !== "error" && run.status !== "system_error") {
    return null;
  }

  if (run.errorType === "user") {
    return run.error ?? "The workflow failed. See the step details below.";
  }

  // System failure: prefer the registry message keyed by the stable code.
  const coded = getCustomerMessageForCode(run.errorCode ?? null);
  if (coded) {
    return coded;
  }

  // Legacy rows without a code keep the prior generic behaviour. The classifier
  // treats unmatched failures as system.
  if (run.errorCategory === "network_rpc") {
    return "Internal network error, please wait 5 minutes and try again.";
  }

  return "Internal error, please wait 5 minutes and try again.";
}
