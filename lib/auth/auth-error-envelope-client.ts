export type AuthErrorBody = {
  error?: string;
  detail?: string;
  code?: string;
};

/** Machine-readable auth error code (KEEP-489 envelope or legacy `code`). */
export function authErrorCode(body: AuthErrorBody): string | undefined {
  return body.error ?? body.code;
}

/** Human-facing message from an auth error response body. */
export function authErrorMessage(
  body: AuthErrorBody,
  fallback: string
): string {
  return body.detail ?? body.error ?? fallback;
}
