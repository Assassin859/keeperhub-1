import { and, desc, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { formatIpForDisplay } from "@/lib/security/ip-normalize";
import {
  formatLocation,
  type ResolvedLocation,
  resolveLocationFromIp,
} from "@/lib/security/resolve-country";

type SessionListItem = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

type SessionListResponse = {
  sessions: SessionListItem[];
};

function mergeLocations(
  primary: ResolvedLocation,
  fallback: ResolvedLocation
): ResolvedLocation {
  return {
    country: primary.country ?? fallback.country,
    region: primary.region ?? fallback.region,
    city: primary.city ?? fallback.city,
  };
}

function decodeLocation(riskFlagsJson: string | null): ResolvedLocation {
  if (!riskFlagsJson) {
    return { country: null, region: null, city: null };
  }
  try {
    const parsed = JSON.parse(riskFlagsJson) as {
      country?: unknown;
      region?: unknown;
      city?: unknown;
    };
    const pick = (value: unknown): string | null => {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };
    const countryRaw = pick(parsed.country);
    return {
      country: countryRaw ? countryRaw.toUpperCase() : null,
      region: pick(parsed.region),
      city: pick(parsed.city),
    };
  } catch {
    return { country: null, region: null, city: null };
  }
}

/**
 * GET /api/user/sessions
 *
 * Returns every active session row owned by the caller for the
 * "Active sessions" settings panel. Each row carries the device's
 * user-agent, the IP attested at sign-in time, the Cloudflare
 * country code if we captured one, and timestamps. `isCurrent`
 * marks the row that matches the caller's current cookie so the UI
 * can label it "This device" and hide the revoke action for it.
 *
 * Hashed-token comparison: the `sessions.token` column stores
 * `sha256(rawToken)` via the `wrapWithSessionTokenHash` adapter
 * wrapper. The session returned by `auth.api.getSession` has its
 * `.token` rewritten back to the raw value the cookie carried, so
 * we match by that session's id rather than by token directly.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (isAnonymousUserShape(session.user)) {
    return NextResponse.json({ sessions: [] } satisfies SessionListResponse);
  }

  const currentId =
    (session.session as { id?: string } | undefined)?.id ?? null;

  const rows = await db
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      riskFlagsJson: sessions.riskFlagsJson,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, session.user.id),
        gt(sessions.expiresAt, new Date())
      )
    )
    .orderBy(desc(sessions.updatedAt));

  // Lazy enrichment for rows whose risk_flags_json predates the
  // city/region fields (or is null, as on sessions minted by
  // /verify-ip which inserts via Drizzle and skips the
  // session.create.before hook). resolveLocationFromIp is cached
  // per IP for 24h, so this is cheap on repeat panel loads.
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const decoded = decodeLocation(row.riskFlagsJson);
      const needsFallback =
        (decoded.city === null || decoded.region === null) && row.ipAddress;
      const merged = needsFallback
        ? mergeLocations(decoded, await resolveLocationFromIp(row.ipAddress))
        : decoded;
      return {
        id: row.id,
        ipAddress: row.ipAddress ? formatIpForDisplay(row.ipAddress) : null,
        userAgent: row.userAgent,
        country: merged.country,
        location: formatLocation(merged),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        isCurrent: currentId === row.id,
      };
    })
  );

  const body: SessionListResponse = { sessions: enriched };
  return NextResponse.json(body);
}
