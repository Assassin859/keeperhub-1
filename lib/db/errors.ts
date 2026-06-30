/**
 * Helpers for classifying Postgres errors surfaced through Drizzle.
 *
 * Drizzle wraps the driver error, so the SQLSTATE code can live either on the
 * thrown error or on its `cause`. Check both.
 */

const PG_UNIQUE_VIOLATION = "23505";

function pgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code;
}

/** True when the error is a Postgres unique-constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}
