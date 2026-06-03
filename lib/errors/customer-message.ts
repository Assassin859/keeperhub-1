import type { ErrorCategory } from "@/lib/logging";

/**
 * Maps a finished workflow run's failure fields to a short, customer-readable
 * message for the run logs UI, or null when the run did not fail.
 *
 * Intentionally hides internal detail for system failures (infra/network/db/
 * engine) and surfaces the raw error only for user-config failures, which are
 * actionable by the workflow author.
 *
 * Kept free of value imports from `@/lib/logging` (which pulls in Sentry and
 * metrics) so it is safe to use in client components; the `network_rpc`
 * literal corresponds to `ErrorCategory.NETWORK_RPC`.
 */
type RunErrorInput = {
  status: string;
  error: string | null;
  errorType: "user" | "system" | null;
  errorCategory: ErrorCategory | string | null;
};

export function getCustomerRunErrorMessage(run: RunErrorInput): string | null {
  if (run.status !== "error") {
    return null;
  }

  if (run.errorType === "user") {
    return run.error ?? "The workflow failed. See the step details below.";
  }

  // system, or null/unknown -- the classifier treats unmatched failures as system
  if (run.errorCategory === "network_rpc") {
    return "Internal network error, please wait 5 minutes and try again.";
  }

  return "Internal error, please wait 5 minutes and try again.";
}
