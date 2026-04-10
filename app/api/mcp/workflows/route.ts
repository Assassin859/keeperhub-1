import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { sanitizeDescription } from "@/lib/sanitize-description";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

const LISTED_WORKFLOW_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  listedAt: workflows.listedAt,
  inputSchema: workflows.inputSchema,
  outputMapping: workflows.outputMapping,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  organizationId: workflows.organizationId,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
  isListed: workflows.isListed,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
};

const CATALOG_RATE_LIMIT = 60;
const CATALOG_RATE_WINDOW_MS = 60_000;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const clientIp = getClientIp(request);
    const rateCheck = checkIpRateLimit(
      clientIp,
      CATALOG_RATE_LIMIT,
      CATALOG_RATE_WINDOW_MS
    );
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": String(rateCheck.retryAfter) },
        }
      );
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") ?? undefined;
    const category = searchParams.get("category") ?? undefined;
    const chain = searchParams.get("chain") ?? undefined;
    const page = Math.max(
      1,
      Number.parseInt(searchParams.get("page") ?? String(DEFAULT_PAGE), 10) ||
        DEFAULT_PAGE
    );
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(
        1,
        Number.parseInt(
          searchParams.get("limit") ?? String(DEFAULT_LIMIT),
          10
        ) || DEFAULT_LIMIT
      )
    );
    const offset = (page - 1) * limit;

    const baseFilter = eq(workflows.isListed, true);
    const textFilter = q
      ? or(
          ilike(workflows.name, `%${escapeLikePattern(q)}%`),
          ilike(workflows.description, `%${escapeLikePattern(q)}%`),
          ilike(workflows.listedSlug, `%${escapeLikePattern(q)}%`)
        )
      : undefined;
    const categoryFilter = category
      ? ilike(workflows.category, `%${escapeLikePattern(category)}%`)
      : undefined;
    const chainFilter = chain
      ? ilike(workflows.chain, `%${escapeLikePattern(chain)}%`)
      : undefined;

    const whereClause = and(
      baseFilter,
      textFilter,
      categoryFilter,
      chainFilter
    );

    const [countResult, rows] = await Promise.all([
      db.select({ count: count() }).from(workflows).where(whereClause),
      db
        .select(LISTED_WORKFLOW_COLUMNS)
        .from(workflows)
        .where(whereClause)
        .orderBy(desc(workflows.listedAt))
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    const items = rows.map((row) => ({
      ...row,
      description: row.description
        ? sanitizeDescription(row.description)
        : null,
    }));

    return NextResponse.json(
      { items, total, page, limit },
      {
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
        },
      }
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
