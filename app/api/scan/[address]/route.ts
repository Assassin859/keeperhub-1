/**
 * GET /api/scan/[address]
 *
 * FUNNEL-01 public, unauthenticated entry point for the scan-to-automate
 * onboarding funnel. No authentication guard — public by App Router default.
 *
 * Abuse-control order (SCAN-14):
 *   1. Validate ethers.isAddress — 400 on malformed (no rate-limit/RPC work).
 *   2. Resolve canonical client IP via getRequestSourceIp (cf-connecting-ip,
 *      set authoritatively by Cloudflare and unforgeable by clients; trusted-
 *      proxy XFF fallback). Never raw x-real-ip / X-Forwarded-For.
 *   3. Postgres-backed rate limit 3/hr/IP via incrementAndCheck. 4th request
 *      within the hour returns 429 BEFORE scanAddress is called.
 *   4. scanAddress handles the 5-min cache short-circuit (SCAN-13) and fans
 *      out to N-chain RPC calls only on a cache miss.
 *
 * T-51-08-06: no @/lib/auth import and no auth call; asserting this in
 * tests keeps the FUNNEL-01 invariant from regressing silently.
 */

import "server-only";

import { ethers } from "ethers";
import { incrementAndCheck } from "@/lib/agentic-wallet/rate-limit";
import { HttpStatus } from "@/lib/http-status";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { scanAddress } from "@/lib/scan/scanner";
import { getRequestSourceIp } from "@/lib/security/request-attribution";

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 3;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
): Promise<Response> {
  const { address } = await params;

  if (!ethers.isAddress(address)) {
    return Response.json(
      { error: "Invalid address" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  // Canonical client IP via cf-connecting-ip (Cloudflare-authoritative,
  // unforgeable). Raw x-real-ip / X-Forwarded-For is client-controllable and
  // would let a caller spoof the rate-limit key to bypass the 3/hr limit.
  // Unattributable requests share one "unknown" bucket so they cannot escape
  // the limit by withholding the header.
  const trustedIp = getRequestSourceIp(request) ?? "unknown";
  const rate = await incrementAndCheck(`scan:${trustedIp}`, RATE_LIMIT_MAX);

  if (!rate.allowed) {
    return applyRateLimitHeaders(
      Response.json(
        { error: "Rate limit exceeded", retryAfter: rate.retryAfter },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rate
    );
  }

  try {
    const result = await scanAddress(address);
    return applyRateLimitHeaders(Response.json(result), rate);
  } catch {
    // Never leak internal/RPC error detail on the public surface.
    return applyRateLimitHeaders(
      Response.json(
        { error: "Scan failed" },
        { status: HttpStatus.INTERNAL_SERVER_ERROR }
      ),
      rate
    );
  }
}
