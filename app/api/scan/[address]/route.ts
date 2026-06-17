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
import { logAnonymousExecutionBlock } from "@/lib/auth-anonymous-guard";
import { HttpStatus } from "@/lib/http-status";
import { createTimer, getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { scanAddress } from "@/lib/scan/scanner";
import { buildSuggestions } from "@/lib/scan/suggestions/engine";
import { getRequestSourceIp } from "@/lib/security/request-attribution";

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 3;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
): Promise<Response> {
  // HARDEN-04: fail-closed feature flag gate. Any absent/empty/non-"true"
  // value → 404 with no validation, rate-limit, or RPC work performed.
  if (process.env.NEXT_PUBLIC_SCAN_ENABLED !== "true") {
    return Response.json(
      { error: "Not found" },
      { status: HttpStatus.NOT_FOUND }
    );
  }

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
    // HARDEN-01: emit abuse telemetry BEFORE returning 429 so the Sentry
    // event fires even if the response pipeline has an edge-case failure.
    // extra values must all be strings (Record<string, string>).
    logAnonymousExecutionBlock("scan", null, {
      ip: trustedIp,
      rateLimitCount: String(rate.count),
      address,
    });
    return applyRateLimitHeaders(
      Response.json(
        { error: "Rate limit exceeded", retryAfter: rate.retryAfter },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rate
    );
  }

  const metricsCollector = getMetricsCollector();
  const scanTimer = createTimer();

  try {
    const result = await scanAddress(address);
    metricsCollector.recordLatency(
      MetricNames.SCAN_ADDRESS_DURATION,
      scanTimer(),
      { status: "success" }
    );
    // T-52-12: buildSuggestions is pure and bounded (<10ms), but any engine
    // error degrades gracefully to [] rather than failing the 200 response.
    let suggestions: ReturnType<typeof buildSuggestions> = [];
    try {
      suggestions = buildSuggestions(result);
    } catch {
      // Engine error — return empty suggestions, do not fail the scan response.
    }
    return applyRateLimitHeaders(
      Response.json({ ...result, suggestions }),
      rate
    );
  } catch {
    metricsCollector.recordLatency(
      MetricNames.SCAN_ADDRESS_DURATION,
      scanTimer(),
      { status: "failure" }
    );
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
