import { and, desc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { sessions, userTrustedIps } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { normalizeIpForTrust } from "@/lib/security/ip-normalize";
import {
  type ResolvedLocation,
  resolveLocationFromIp,
} from "@/lib/security/resolve-country";

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
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  recentCountries: readonly string[];
};

const RECENT_SESSION_LOOKBACK = 25;
// Impossible-travel thresholds. We only consider a hop suspicious once it
// covers real ground (city-level geo-IP jitters within a metro, so a
// sub-100km delta is noise) AND would require a speed no commercial
// itinerary sustains. 800 km/h is comfortably above airliner cruise once
// door-to-door time is included, so anything past it implies the two
// logins are not the same physical traveller.
const MIN_TRAVEL_DISTANCE_KM = 100;
const MAX_PLAUSIBLE_VELOCITY_KMH = 800;
// Floor on the elapsed time so a near-simultaneous pair of logins from
// far-apart coordinates yields a huge (correctly flagged) velocity
// instead of dividing by zero.
const MIN_ELAPSED_HOURS = 1 / 3600;
const EARTH_RADIUS_KM = 6371;
const NULL_RISK: LoginRiskSignal = {
  anomaly: false,
  reasons: [],
  country: null,
  region: null,
  city: null,
  latitude: null,
  longitude: null,
  recentCountries: [],
};

/**
 * Resolves the geographic location of the current request. CF-IPCountry
 * is authoritative at our edge and gets trusted whenever
 * CF-Connecting-IP is also present. When CF didn't attest a country
 * (no edge in the path, or it returned XX/T1), fall back to an
 * external IP-to-location lookup so the active-sessions panel still
 * shows a useful label for VPN / tunnel / local-dev sessions. The
 * fallback also enriches the response with region + city, which CF
 * never provides on its own. Cached per IP so repeated sign-ins
 * from the same address don't refetch.
 */
async function resolveLoginLocation(): Promise<ResolvedLocation> {
  let header: Awaited<ReturnType<typeof headers>>;
  try {
    header = await headers();
  } catch {
    return {
      country: null,
      region: null,
      city: null,
      latitude: null,
      longitude: null,
    };
  }
  const cfConnectingIp = header.get("cf-connecting-ip");
  const cfCountry = header.get("cf-ipcountry");
  const ip = await resolveLoginIp();
  if (cfConnectingIp && cfCountry && cfCountry !== "XX" && cfCountry !== "T1") {
    // CF gave us country at the edge. We still want region, city, and
    // coordinates (CF provides none of those) for the active-sessions
    // panel and impossible-travel detection, so layer the provider
    // chain on top and keep CF's authoritative country.
    const fallback = await resolveLocationFromIp(ip);
    return {
      country: cfCountry.toUpperCase(),
      region: fallback.region,
      city: fallback.city,
      latitude: fallback.latitude,
      longitude: fallback.longitude,
    };
  }
  return await resolveLocationFromIp(ip);
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

type LocatedSession = {
  latitude: number;
  longitude: number;
  createdAt: Date;
};

/**
 * Returns the most recent prior session that recorded coordinates, the
 * anchor impossible-travel measures the current login against. Reads the
 * same `risk_flags_json` blobs as loadRecentCountries; sessions minted
 * before coordinates were captured (or via paths that don't resolve
 * them) carry none and are skipped. Rows come back newest-first, so the
 * first one with valid coordinates is the freshest reference point.
 */
async function loadMostRecentLocatedSession(
  userId: string
): Promise<LocatedSession | null> {
  const rows = await db
    .select({
      riskFlagsJson: sessions.riskFlagsJson,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(RECENT_SESSION_LOOKBACK);
  for (const row of rows) {
    if (!row.riskFlagsJson) {
      continue;
    }
    try {
      const parsed = JSON.parse(row.riskFlagsJson) as {
        latitude?: unknown;
        longitude?: unknown;
      };
      if (
        typeof parsed.latitude === "number" &&
        typeof parsed.longitude === "number" &&
        Number.isFinite(parsed.latitude) &&
        Number.isFinite(parsed.longitude)
      ) {
        return {
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          createdAt: row.createdAt,
        };
      }
    } catch {
      // Tolerate malformed rows — risk_flags_json is best-effort.
    }
  }
  return null;
}

/** Great-circle distance between two coordinates, in kilometres. */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * True when reaching `current` from `prior` in the elapsed wall-clock
 * time would require a physically implausible speed. Short hops (within
 * MIN_TRAVEL_DISTANCE_KM) are ignored so city-level geo-IP jitter doesn't
 * masquerade as travel. `nowMs` is the current login's timestamp; the
 * elapsed time is floored so a near-instant teleport divides cleanly.
 */
function isImpossibleTravel(
  prior: LocatedSession,
  currentLat: number,
  currentLon: number,
  nowMs: number
): boolean {
  const distanceKm = haversineKm(
    prior.latitude,
    prior.longitude,
    currentLat,
    currentLon
  );
  if (distanceKm < MIN_TRAVEL_DISTANCE_KM) {
    return false;
  }
  const elapsedHours = Math.max(
    (nowMs - prior.createdAt.getTime()) / 3_600_000,
    MIN_ELAPSED_HOURS
  );
  const velocityKmh = distanceKm / elapsedHours;
  return velocityKmh > MAX_PLAUSIBLE_VELOCITY_KMH;
}

/**
 * Computes a risk signal for the in-flight login. Called from
 * databaseHooks.session.create.before in lib/auth.ts. Pure read; never
 * writes. Callers persist the result into sessions.risk_flags_json and
 * decide whether to flip sessions.requires_mfa based on the user's TOTP
 * enrollment state.
 *
 * Two independent signals are merged into one `anomaly`:
 *  - Country: empty history -> first_geo_attestation; known country ->
 *    clean; unseen country -> new_country anomaly.
 *  - Impossible travel: when the current login carries coordinates and a
 *    prior located session exists, an implausible velocity between them
 *    flags impossible_travel — even when the country is familiar, which
 *    is the same-country-different-city gap country-only detection misses.
 */
export async function assessLoginRisk(
  userId: string
): Promise<LoginRiskSignal> {
  const location = await resolveLoginLocation();
  const { country, region, city, latitude, longitude } = location;
  if (!country) {
    return NULL_RISK;
  }
  const priorCountries = await loadRecentCountries(userId);
  const reasons: string[] = [];
  let anomaly = false;
  let recentCountries: string[] = [];

  if (priorCountries.length === 0) {
    reasons.push("first_geo_attestation");
  } else if (priorCountries.includes(country)) {
    recentCountries = priorCountries.filter((c) => c !== country);
  } else {
    anomaly = true;
    reasons.push("new_country");
    recentCountries = priorCountries;
  }

  // Impossible-travel runs regardless of the country verdict so a
  // same-country hop (familiar country, distant city) is still caught.
  // Needs coordinates on both ends; absent either, we stay silent rather
  // than flag on a missing signal — the same philosophy as the country
  // check skipping null attestations.
  if (latitude !== null && longitude !== null) {
    const prior = await loadMostRecentLocatedSession(userId);
    if (prior && isImpossibleTravel(prior, latitude, longitude, Date.now())) {
      anomaly = true;
      reasons.push("impossible_travel");
    }
  }

  return {
    anomaly,
    reasons,
    country,
    region,
    city,
    latitude,
    longitude,
    recentCountries,
  };
}

/**
 * Serializes a risk signal for storage in sessions.risk_flags_json.
 * Kept stable so prior-session lookups can decode older rows. The
 * `region`/`city` and later `latitude`/`longitude` fields were added
 * over time; absence on a stored blob is treated as null by callers, so
 * older rows decode cleanly and contribute no coordinate anchor.
 */
export function serializeRiskFlags(signal: LoginRiskSignal): string {
  return JSON.stringify({
    anomaly: signal.anomaly,
    reasons: signal.reasons,
    country: signal.country,
    region: signal.region,
    city: signal.city,
    latitude: signal.latitude,
    longitude: signal.longitude,
    recentCountries: signal.recentCountries,
  });
}

/**
 * Builds a sessions.risk_flags_json blob for a session that wasn't
 * minted through the session.create.before path (the /verify-ip
 * Drizzle insert is the only such caller today). Resolves the
 * geographic location for the IP via the shared IP-to-location
 * provider abstraction and serializes via the same
 * `serializeRiskFlags` shape Better Auth's adapter writes, so
 * downstream readers (the active-sessions panel, future audit
 * tooling) don't have to special-case the source of the row.
 *
 * `attestedCountry` is an optional override for the country field —
 * pass the CF-attested code captured at strict-signin time when
 * available, otherwise the resolver fills it from the lookup.
 */
export async function buildRiskFlagsJsonForIp(
  ip: string | null,
  attestedCountry: string | null = null
): Promise<string> {
  const location = await resolveLocationFromIp(ip);
  return serializeRiskFlags({
    anomaly: false,
    reasons: [],
    country: attestedCountry ?? location.country,
    region: location.region,
    city: location.city,
    latitude: location.latitude,
    longitude: location.longitude,
    recentCountries: [],
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
 *
 *                                         Migration caveat: when this
 *                                         feature ships, every existing
 *                                         user has zero rows in
 *                                         user_trusted_ips, so their
 *                                         FIRST sign-in after deploy
 *                                         auto-trusts the IP they happen
 *                                         to be on. /verify-ip only kicks
 *                                         in for SUBSEQUENT new IPs after
 *                                         that. We accept this rather
 *                                         than backfilling because the
 *                                         backfill would have to read
 *                                         sessions.ip_address, which is
 *                                         the raw value Better Auth
 *                                         records (no CF attestation)
 *                                         and is null for sessions
 *                                         created before the IP-risk
 *                                         work landed, so seeding from
 *                                         it would either lock those
 *                                         users out or trust whatever
 *                                         their proxy decided to log
 *                                         which is no stronger than
 *                                         what we do here.
 *   - subsequent unknown ip            -> trusted = false. Caller sets
 *                                         requires_ip_verification on
 *                                         the new session.
 */
export type IpTrust = {
  ip: string | null;
  rawIp: string | null;
  trusted: boolean;
  country: string | null;
  reason: "no_cf" | "known" | "first" | "untrusted";
};

/**
 * Structured trace for the IP-verification gate. Logs the raw
 * (pre-normalization) client IP alongside the normalized /24-or-/64
 * trust key at every stage so a rotating egress IP -- the failure mode
 * where a user gets the new-network modal but the codes never line up
 * -- is greppable end to end via `[ip-verify]`.
 */
export function logIpVerify(
  stage: string,
  fields: Record<string, unknown>
): void {
  console.info(`[ip-verify] ${stage}`, fields);
}

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

/**
 * Per-request gate result. `trusted` means the current request's IP is
 * in the user's `user_trusted_ips` list. `untrusted` carries the IP and
 * CF-attested country so the caller can build the pending_ip_verify
 * cookie + notification email without re-resolving the headers.
 */
export type RequestIpGate =
  | { kind: "trusted" }
  | { kind: "untrusted"; ip: string; country: string | null }
  | { kind: "no_ip" };

/**
 * Per-pod TTL cache for gate results. A single page navigation in the
 * KeeperHub app fans out into ~20 parallel API requests, each of which
 * passes through the proxy. Without caching the gate would do one DB
 * round-trip per request, plus a redundant evaluation of every header
 * lookup. The cache collapses those to one DB hit per (user, ip) per
 * TTL window.
 *
 * Trusted results get a long TTL because the trust list rarely changes
 * for an active user. Untrusted gets a short TTL so that once the user
 * completes /verify-ip the next request picks up the new trust quickly
 * without requiring cross-pod invalidation; same-pod invalidation is
 * driven explicitly from /api/user/verify-ip via clearTrustCacheEntry.
 * `no_ip` is rare and stable (only fires when CF-Connecting-IP is
 * missing) so it gets the long TTL too.
 */
type CachedTrust = { result: RequestIpGate; expiresAt: number };
const TRUST_CACHE = new Map<string, CachedTrust>();
const TRUST_CACHE_LIMIT = 10_000;
const TRUSTED_TTL_MS = 300_000;
const UNTRUSTED_TTL_MS = 30_000;

function trustCacheKey(userId: string, ip: string): string {
  return `${userId}:${ip}`;
}

function rememberTrust(key: string, entry: CachedTrust): void {
  if (TRUST_CACHE.size >= TRUST_CACHE_LIMIT) {
    const retained = Array.from(TRUST_CACHE.entries()).slice(
      -Math.floor(TRUST_CACHE_LIMIT / 2)
    );
    TRUST_CACHE.clear();
    for (const [k, v] of retained) {
      TRUST_CACHE.set(k, v);
    }
  }
  TRUST_CACHE.set(key, entry);
}

/**
 * Drop the cached gate result for this (user, ip). Called by
 * /api/user/verify-ip after a successful upsert so the next request on
 * the same pod sees the freshly-trusted IP without waiting for the
 * untrusted TTL to expire. Cross-pod stale entries age out on their own
 * within UNTRUSTED_TTL_MS.
 */
export function clearTrustCacheEntry(userId: string, ip: string): void {
  TRUST_CACHE.delete(trustCacheKey(userId, ip));
}

/**
 * Per-request IP gate consulted by the root proxy on every authenticated
 * request. Unlike assessIpTrust (used at sign-in time), this never
 * grants a first-attestation: if the user has zero trusted IPs we still
 * return untrusted, on the theory that a session that exists with no
 * trust rows means the sign-in path's bookkeeping failed and we should
 * fail closed.
 *
 * No DB writes here. The trust list only grows via sign-in events
 * (session.create.before first-attestation) and explicit /verify-ip
 * confirmation; the proxy gate is read-only.
 */
export async function gateRequestIp(userId: string): Promise<RequestIpGate> {
  const rawIp = await resolveLoginIp();
  if (!rawIp) {
    const result: RequestIpGate = { kind: "no_ip" };
    return result;
  }
  const ip = normalizeIpForTrust(rawIp);
  const key = trustCacheKey(userId, ip);
  const now = Date.now();
  const cached = TRUST_CACHE.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }
  const [hit] = await db
    .select({ id: userTrustedIps.id })
    .from(userTrustedIps)
    .where(and(eq(userTrustedIps.userId, userId), eq(userTrustedIps.ip, ip)))
    .limit(1);
  if (hit) {
    const result: RequestIpGate = { kind: "trusted" };
    rememberTrust(key, { result, expiresAt: now + TRUSTED_TTL_MS });
    return result;
  }
  // CF-attested country only on the hot path; the external IP-to-location
  // lookup has a 2-second timeout and isn't wanted here.
  let country: string | null = null;
  try {
    const header = await headers();
    country = header.get("cf-ipcountry") ?? null;
  } catch {
    country = null;
  }
  const result: RequestIpGate = { kind: "untrusted", ip, country };
  rememberTrust(key, { result, expiresAt: now + UNTRUSTED_TTL_MS });
  logIpVerify("gate-untrusted", {
    userId,
    rawIp,
    normalizedIp: ip,
    country,
  });
  return result;
}

export async function assessIpTrust(userId: string): Promise<IpTrust> {
  const rawIp = await resolveLoginIp();
  const { country } = await resolveLoginLocation();
  if (!rawIp) {
    logIpVerify("assess", {
      userId,
      rawIp: null,
      normalizedIp: null,
      reason: "no_cf",
    });
    return { ip: null, rawIp: null, trusted: true, country, reason: "no_cf" };
  }

  // IPv6 trust is bucketed at /64 to handle CF's lower-64-bits
  // zeroing for privacy and any SLAAC reshuffles on the same
  // network. IPv4 passes through unchanged. Callers (cookie
  // payload, /verify-ip insert) use the normalized form too so
  // the same string is what ever lands in user_trusted_ips.
  const ip = normalizeIpForTrust(rawIp);

  const [hit] = await db
    .select({ id: userTrustedIps.id })
    .from(userTrustedIps)
    .where(and(eq(userTrustedIps.userId, userId), eq(userTrustedIps.ip, ip)))
    .limit(1);
  if (hit) {
    logIpVerify("assess", { userId, rawIp, normalizedIp: ip, reason: "known" });
    return { ip, rawIp, trusted: true, country, reason: "known" };
  }

  const [anyTrusted] = await db
    .select({ id: userTrustedIps.id })
    .from(userTrustedIps)
    .where(eq(userTrustedIps.userId, userId))
    .limit(1);
  if (!anyTrusted) {
    logIpVerify("assess", { userId, rawIp, normalizedIp: ip, reason: "first" });
    return { ip, rawIp, trusted: true, country, reason: "first" };
  }

  logIpVerify("assess", {
    userId,
    rawIp,
    normalizedIp: ip,
    reason: "untrusted",
  });
  return { ip, rawIp, trusted: false, country, reason: "untrusted" };
}

/**
 * Idempotently record an IP in a user's trusted list. The unique
 * (user_id, ip) constraint makes the upsert safe to repeat: a known IP
 * just bumps last_seen_at. Best-effort by design. A failure is logged
 * and swallowed because trust-list bookkeeping must never block the
 * sign-in that triggered it. If the write is lost, the next sign-in
 * from the same IP hits the /verify-ip gate, which is the correct
 * fail-closed direction.
 */
export async function upsertTrustedIp(
  userId: string,
  ip: string,
  country: string | null
): Promise<void> {
  try {
    await db
      .insert(userTrustedIps)
      .values({ userId, ip, country })
      .onConflictDoUpdate({
        target: [userTrustedIps.userId, userTrustedIps.ip],
        set: { lastSeenAt: new Date() },
      });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[ip-trust] failed to upsert trusted IP",
      err,
      { user_id: userId, ip }
    );
  }
}

/**
 * Record the current request's source IP as trusted for this user,
 * mirroring the databaseHooks.session.create.before path in lib/auth.ts.
 * Called by the pending-signup TOTP enroll path, which mints a user's
 * first session by inserting the row directly and so never runs that
 * hook. Without it a credential signup never records its origin IP, so a
 * later sign-in from that very network is treated as new and bounced to
 * /verify-ip. (OAuth signup does not need this: its callback mints a
 * Better Auth session first, which runs the hook before being discarded.)
 *
 * Records only on a positive trust decision: first-ever attestation or
 * an already-known IP, exactly as the hook does. An untrusted IP is left
 * for the /verify-ip gate to resolve.
 */
export async function recordTrustedIpFromRequest(
  userId: string
): Promise<void> {
  const ipTrust = await assessIpTrust(userId);
  if (ipTrust.ip && ipTrust.trusted) {
    await upsertTrustedIp(userId, ipTrust.ip, ipTrust.country);
  }
}
