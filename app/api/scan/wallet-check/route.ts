import type { NextResponse } from "next/server";

/**
 * GET /api/scan/wallet-check
 *
 * Returns { hasWallet: boolean } for the authenticated user's organisation.
 * Used by PendingScanRunner (and eventually the suggestion preview drawer) to
 * gate write-type suggestion flows behind Turnkey wallet provision (FUNNEL-05).
 *
 * All v1.13 suggestions are read-only; this endpoint is forward-compat only
 * and is exercised via the SYNTHETIC_WRITE_DESCRIPTOR test fixture.
 *
 * Implementation lands in Plan 54-04.
 */
export function GET(_request: Request): Promise<NextResponse> {
  throw new Error("not implemented: 54-04");
}
