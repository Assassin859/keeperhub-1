import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { workflowPayments } from "@/lib/db/schema-payments";

export type MarketplaceSort = "popular" | "newest" | "top-calls";

export type MarketplaceLeaderboardRow = {
  workflowId: string;
  listedSlug: string | null;
  displayName: string;
  callCount: number;
  priceUsdcPerCall: string | null;
  chain: string | null;
  listedAt: Date | null;
};

export type MarketplaceLeaderboardResult = {
  rows: MarketplaceLeaderboardRow[];
  nextCursor: string | null;
  total: number;
};

const PAGE_LIMIT = 50;

type CursorPayload = {
  c: number; // last callCount
  i: string; // last workflowId tiebreaker
};

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): CursorPayload | null {
  if (!raw) {
    return null;
  }
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.c !== "number" || typeof parsed.i !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function runLeaderboardQuery(
  sort: MarketplaceSort,
  cursor: CursorPayload | null,
  query: string
): Promise<MarketplaceLeaderboardResult> {
  // PUBLIC COLUMN WHITELIST -- see MARKET-04. Adding fields here requires
  // re-reading MARKET-04 + MARKET-13 first. NEVER add private columns:
  //   - workflows.{user identity, org identity}
  //   - workflowPayments.{usdc amount, payer wallet, creator wallet}
  // The grep gate in 44-05 acceptance asserts these literal identifiers
  // appear ZERO times in this file -- spell them out in PROSE only.
  const callCountExpr = sql<number>`coalesce(count(${workflowPayments.id})::int, 0)`;

  const baseFilter = eq(workflows.isListed, true);

  // Cursor filter for popular/top-calls (callCount tiebroken by id).
  // Newest sort uses listedAt cursor (separate path below).
  const cursorFilter =
    cursor && (sort === "popular" || sort === "top-calls")
      ? or(
          lt(callCountExpr, cursor.c),
          and(eq(callCountExpr, cursor.c), lt(workflows.id, cursor.i))
        )
      : undefined;

  // Free-text filter on the public display name. Case-insensitive, simple
  // substring match; no full-text indexing yet — fine at v1.11 scale.
  const queryFilter =
    query === "" ? undefined : ilike(workflows.name, `%${query}%`);

  const whereClause = and(baseFilter, cursorFilter, queryFilter);

  const orderClause =
    sort === "newest"
      ? [desc(workflows.listedAt), desc(workflows.id)]
      : [desc(callCountExpr), desc(workflows.id)];

  const rows = await db
    .select({
      workflowId: workflows.id,
      listedSlug: workflows.listedSlug,
      displayName: workflows.name,
      callCount: callCountExpr,
      priceUsdcPerCall: workflows.priceUsdcPerCall,
      chain: workflows.chain,
      listedAt: workflows.listedAt,
    })
    .from(workflows)
    .leftJoin(workflowPayments, eq(workflowPayments.workflowId, workflows.id))
    .where(whereClause)
    .groupBy(workflows.id)
    .orderBy(...orderClause)
    .limit(PAGE_LIMIT + 1);

  // Total count of listed workflows matching the active query (for the
  // "Showing 1-N of TOTAL" footer). Single COUNT(*) — cheap because
  // workflows.is_listed has an index path; the optional ILIKE adds a
  // small linear scan over the listed subset.
  const totalRow = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(workflows)
    .where(and(baseFilter, queryFilter));
  const total = totalRow[0]?.value ?? 0;

  const hasMore = rows.length > PAGE_LIMIT;
  const pageRows = hasMore ? rows.slice(0, PAGE_LIMIT) : rows;
  const last = pageRows.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({ c: last.callCount, i: last.workflowId })
      : null;

  return { rows: pageRows, nextCursor, total };
}

export const fetchMarketplaceLeaderboard = unstable_cache(
  async (
    sort: MarketplaceSort,
    cursorRaw: string | null,
    query: string
  ): Promise<MarketplaceLeaderboardResult> => {
    const cursor = decodeCursor(cursorRaw);
    return await runLeaderboardQuery(sort, cursor, query);
  },
  ["marketplace-leaderboard"],
  { revalidate: 60, tags: ["marketplace"] }
);

export { encodeCursor as encodeMarketplaceCursor };
