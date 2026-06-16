import { timingSafeEqual } from "node:crypto";

/**
 * Bearer-token authorization for scheduler-invoked cron endpoints.
 *
 * Runs in every environment -- there is no NODE_ENV bypass, so a non-prod
 * container (e.g. a publicly reachable staging) cannot serve the endpoint
 * unauthenticated. Fails closed with 503 when CRON_SECRET is unset rather
 * than running open. The token comparison is constant-time so a caller
 * cannot recover the secret byte-by-byte via response timing.
 *
 * Returns a Response to send back when authorization fails, or null when the
 * caller is authorized and the handler should proceed.
 */
export function authorizeCronRequest(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "Cron not configured" }, { status: 503 });
  }

  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  // timingSafeEqual throws on length mismatch, so the length guard runs first.
  // It leaks only the expected length (`"Bearer " + secret`), which a caller
  // cannot usefully exploit.
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
