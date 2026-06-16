/**
 * GET /api/scan/[address]
 *
 * FUNNEL-01 public, unauthenticated entry point for the scan-to-automate
 * onboarding funnel. No authentication guard — public by App Router default.
 *
 * Abuse-control order (SCAN-14):
 *   1. Validate ethers.isAddress — 400 on malformed (no rate-limit/RPC work).
 *   2. Resolve trusted client IP via resolveTrustedClientIp (Cloudflare CIDR
 *      trust chain; never raw X-Forwarded-For header).
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
import { resolveTrustedClientIp } from "@/lib/security/trusted-proxies";

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 3;

function getPeerIp(request: Request): string | null {
  const ip = (request as unknown as { ip?: string }).ip;
  return ip ?? request.headers.get("x-real-ip");
}

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

  const peerIp = getPeerIp(request);
  const trustedIp = resolveTrustedClientIp(request, peerIp);
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

  const result = await scanAddress(address);
  return applyRateLimitHeaders(Response.json(result), rate);
}
