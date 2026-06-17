import type { NextResponse } from "next/server";

/**
 * POST /api/auth/scan-intent
 * Body: { intent: string } — JSON-serialised SuggestionDescriptor + mode + address.
 *
 * Sets a short-lived pending_scan HttpOnly cookie that survives the OAuth
 * round-trip. Mirrors app/api/auth/template-intent/route.ts exactly.
 *
 * Implementation lands in Plan 54-02.
 */
export function POST(_request: Request): Promise<NextResponse> {
  throw new Error("not implemented: 54-02");
}

/**
 * GET /api/auth/scan-intent
 *
 * Returns { intent: ScanIntent | null } and atomically clears the cookie
 * (maxAge=0). Mirrors template-intent GET. Implementation in Plan 54-02.
 */
export function GET(): Promise<NextResponse> {
  throw new Error("not implemented: 54-02");
}
