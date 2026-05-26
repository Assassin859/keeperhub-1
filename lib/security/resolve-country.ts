/**
 * IP-to-location resolver. Cloudflare's `CF-IPCountry` only gives a
 * 2-letter ISO code; the active-sessions panel wants a richer
 * "Buenos Aires, BA, AR" style string so users can recognise where
 * each session signed in from at a glance. CF still wins when it's
 * present (cheap, attested at the edge); this fallback fills in for
 * local-dev, tunnel, and XX/T1 cases, AND enriches the response
 * with city + region.
 *
 * `ipapi.co/<ip>/json/` returns a JSON blob including country_code,
 * region_code and city. Free tier, no API key, rate-limited to
 * ~1000 lookups per day across this pod. Backed by a 24h in-memory
 * cache keyed on IP since session creation only needs the resolve
 * once and IPs don't change country.
 *
 * 2 second timeout so the lookup can't block the sign-in critical
 * path; failures fall through to null and the caller treats the
 * location as unknown.
 */

export type ResolvedLocation = {
  country: string | null;
  region: string | null;
  city: string | null;
};

const NULL_LOCATION: ResolvedLocation = {
  country: null,
  region: null,
  city: null,
};

const CACHE = new Map<
  string,
  { location: ResolvedLocation; expiresAt: number }
>();
const TTL_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 2000;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

type IpapiResponse = {
  country_code?: unknown;
  region_code?: unknown;
  region?: unknown;
  city?: unknown;
  error?: unknown;
};

function pickString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveLocationFromIp(
  ip: string | null
): Promise<ResolvedLocation> {
  if (!ip) {
    return NULL_LOCATION;
  }
  const cached = CACHE.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.location;
  }
  let location: ResolvedLocation = NULL_LOCATION;
  try {
    const res = await fetch(
      `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      }
    );
    if (res.ok) {
      const data = (await res.json()) as IpapiResponse;
      if (!data.error) {
        const countryRaw = pickString(data.country_code)?.toUpperCase() ?? null;
        location = {
          country:
            countryRaw && COUNTRY_CODE_RE.test(countryRaw) ? countryRaw : null,
          region:
            pickString(data.region_code) ?? pickString(data.region) ?? null,
          city: pickString(data.city),
        };
      }
    }
  } catch {
    // Network / abort / parse failures fall through to NULL_LOCATION.
  }
  CACHE.set(ip, { location, expiresAt: Date.now() + TTL_MS });
  return location;
}

/**
 * Compact display string. `"San Francisco, CA, US"` for a fully-
 * resolved row, `"AR"` when only the country code is known,
 * `null` when nothing at all was resolved.
 */
export function formatLocation(location: ResolvedLocation): string | null {
  const parts = [location.city, location.region, location.country].filter(
    (p): p is string => p !== null && p.length > 0
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.join(", ");
}
