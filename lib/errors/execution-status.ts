/**
 * Execution status values that represent a failed run. `error` is a user- or
 * workflow-caused failure; `system_error` is a platform/infrastructure failure
 * (`error_type = "system"`): SQS/dispatch problems, lost messages, reaped
 * timeouts. Splitting them gives operators a status they can see and filter on,
 * separate from user-actionable errors.
 *
 * Kept dependency-free so it is safe to import from client components and from
 * the executor/scheduler processes alike.
 */
export const ERROR_STATUSES = ["error", "system_error"] as const;

export type ErrorStatus = (typeof ERROR_STATUSES)[number];

/** SQL list literal for `status IN (...)` predicates over both error statuses. */
export const ERROR_STATUSES_SQL = "('error', 'system_error')";

/** Map an error_type to the execution status that should be persisted. */
export function statusForErrorType(
  errorType: "user" | "system" | null | undefined
): ErrorStatus {
  return errorType === "system" ? "system_error" : "error";
}
