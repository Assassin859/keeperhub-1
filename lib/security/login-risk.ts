import { and, desc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { sessions, userTrustedIps } from "@/lib/db/schema";

/**
 * Risk signal emitted by the login-time anomaly check. `anomaly: true`
 * means the application should require step-up MFA before honoring the
 * session. `reasons` is read-only diagnostic context for logging and the
 * sessions.risk_flags_json column; it never reaches the end user.
 *
 * `country` is the resolved Cloudflare-attested country for the login.
 * Null when the request did not arrive via Cloudflare (local dev, direct
 * origin access). When null, the geo check is treated as inconclusive
 * (anomaly = false) — we do not flag based on missing signal, because
 * doing so would trip every local-dev login and self-hosted setup.
 */
export type LoginRiskSignal = {
  anomaly: boolean;
  reasons: readonly string[];
  country: string | null;
  recentCountries: readonly string[];
};

const RECENT_SESSION_LOOKBACK = 25;
const NULL_RISK: LoginRiskSignal = {
  anomaly: false,
  reasons: [],
  country: null,
  recentCountries: [],
};

/**
 * Reads CF-IPCountry from the current request. Trusted only when
 * CF-Connecting-IP is also present, which only Cloudflare sets and our
 * origin is fronted by Cloudflare in staging/prod. Untrusted requests
 * (no CF headers) return null and the caller treats geo as unknown.
 */
async function resolveLoginCountry(): Promise<string | null> {
  let header: Awaited<ReturnType<typeof headers>>;
  try {
    header = await headers();
  } catch {
    return null;
  }
  const cfConnectingIp = header.get("cf-connecting-ip");
  if (!cfConnectingIp) {
    return null;
  }
  const country = header.get("cf-ipcountry");
  if (!country || country === "XX" || country === "T1") {
    return null;
  }
  return country.toUpperCase();
}

/**
 * Returns the distinct set of countries this user has signed in from
 * across their most recent sessions. Uses the session's own
 * `risk_flags_json` to cheaply read prior country attestations without an
 * IP-to-country lookup; sessions written before risk tracking landed
 * contribute nothing (null country) and are silently skipped.
 *
 * Returns ALL prior countries including any that match the current
 * login country — the caller does the inclusion check to decide whether
 * the current country is new vs. familiar.
 */
async function loadRecentCountries(userId: string): Promise<string[]> {
  const rows = await db
    .select({ riskFlagsJson: sessions.riskFlagsJson })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(RECENT_SESSION_LOOKBACK);
  const countries = new Set<string>();
  for (const row of rows) {
    if (!row.riskFlagsJson) {
      continue;
    }
    try {
      const parsed = JSON.parse(row.riskFlagsJson) as { country?: unknown };
      if (typeof parsed.country === "string" && parsed.country.length === 2) {
        countries.add(parsed.country.toUpperCase());
      }
    } catch {
      // Tolerate malformed rows — risk_flags_json is best-effort.
    }
  }
  return [...countries];
}

/**
 * Computes a risk signal for the in-flight login. Called from
 * databaseHooks.session.create.before in lib/auth.ts. Pure read; never
 * writes. Callers persist the result into sessions.risk_flags_json and
 * decide whether to flip sessions.requires_mfa based on the user's TOTP
 * enrollment state.
 *
 * Decision table once we have a CF-attested country:
 *  - prior history empty           -> first_geo_attestation, no anomaly
 *  - history includes this country -> known location, no anomaly
 *  - history exists, no match      -> new_country, anomaly
 */
export async function assessLoginRisk(
  userId: string
): Promise<LoginRiskSignal> {
  const country = await resolveLoginCountry();
  if (!country) {
    return NULL_RISK;
  }
  const priorCountries = await loadRecentCountries(userId);
  if (priorCountries.length === 0) {
    return {
      anomaly: false,
      reasons: ["first_geo_attestation"],
      country,
      recentCountries: [],
    };
  }
  if (priorCountries.includes(country)) {
    const others = priorCountries.filter((c) => c !== country);
    return {
      anomaly: false,
      reasons: [],
      country,
      recentCountries: others,
    };
  }
  return {
    anomaly: true,
    reasons: ["new_country"],
    country,
    recentCountries: priorCountries,
  };
}

/**
 * Serializes a risk signal for storage in sessions.risk_flags_json.
 * Kept stable so prior-session lookups can decode older rows.
 */
export function serializeRiskFlags(signal: LoginRiskSignal): string {
  return JSON.stringify({
    anomaly: signal.anomaly,
    reasons: signal.reasons,
    country: signal.country,
    recentCountries: signal.recentCountries,
  });
}

/**
 * Trust decision for the in-flight session's source IP. Called from
 * databaseHooks.session.create.before alongside assessLoginRisk so
 * the row written for the new session captures both signals.
 *
 *   - `ip: null`                       -> request did not arrive via
 *                                         Cloudflare; no IP signal to
 *                                         act on. Treat as trusted to
 *                                         avoid locking out local-dev
 *                                         and self-hosted setups.
 *   - `trusted: true`                  -> ip appears in user_trusted_ips
 *                                         for this user. No /verify-ip
 *                                         needed.
 *   - first attestation for this user  -> trusted = true. Mirrors the
 *                                         "first-geo-attestation" rule
 *                                         in assessLoginRisk: a brand
 *                                         new user cannot satisfy
 *                                         /verify-ip (they have no
 *                                         TOTP yet). The IP is added
 *                                         to user_trusted_ips by the
 *                                         session.create.after hook.
 *   - subsequent unknown ip            -> trusted = false. Caller sets
 *                                         requires_ip_verification on
 *                                         the new session.
 */
export type IpTrust = {
  ip: string | null;
  trusted: boolean;
  country: string | null;
  reason: "no_cf" | "known" | "first" | "unknown";
};

async function resolveLoginIp(): Promise<string | null> {
  try {
    const header = await headers();
    const cfConnectingIp = header.get("cf-connecting-ip");
    if (cfConnectingIp) {
      return cfConnectingIp;
    }
    // Cloudflare is the trusted source in staging/prod. In other
    // environments we fall back to the first X-Forwarded-For hop and
    // then to X-Real-IP so VPN / NAT changes during local dev still
    // exercise the new-IP gate. NODE_ENV-gated because in CF-fronted
    // environments these headers are caller-controlled and must not
    // be trusted.
    if (process.env.NODE_ENV !== "production") {
      const xff = header.get("x-forwarded-for");
      const xffFirst = xff?.split(",")[0]?.trim();
      if (xffFirst) {
        return xffFirst;
      }
      const xRealIp = header.get("x-real-ip");
      if (xRealIp) {
        return xRealIp;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function assessIpTrust(userId: string): Promise<IpTrust> {
  const ip = await resolveLoginIp();
  const country = await resolveLoginCountry();
  if (!ip) {
    return { ip: null, trusted: true, country, reason: "no_cf" };
  }

  const [hit] = await db
    .select({ id: userTrustedIps.id })
    .from(userTrustedIps)
    .where(and(eq(userTrustedIps.userId, userId), eq(userTrustedIps.ip, ip)))
    .limit(1);
  if (hit) {
    return { ip, trusted: true, country, reason: "known" };
  }

  const [anyTrusted] = await db
    .select({ id: userTrustedIps.id })
    .from(userTrustedIps)
    .where(eq(userTrustedIps.userId, userId))
    .limit(1);
  if (!anyTrusted) {
    return { ip, trusted: true, country, reason: "first" };
  }

  return { ip, trusted: false, country, reason: "unknown" };
}
