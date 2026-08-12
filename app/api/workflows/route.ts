import { and, asc, count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { MAX_PAGE_SIZE } from "@/lib/pagination";

/**
 * The page cap is the shared one, imported rather than restated. A second
 * MAX_PAGE_SIZE here was a silent divergence: 500 against lib/pagination.ts's
 * 200, for no reason beyond the order the two were written in.
 */
const MAX_OFFSET = Number.MAX_SAFE_INTEGER;

/**
 * A bounded integer, or null when the parameter was absent. Throws on junk.
 *
 * `min` differs per parameter and the difference is load-bearing: a limit of 0
 * requests nothing, but an OFFSET of 0 is the FIRST PAGE of every pager ever
 * written - `for (let p = 0; ; p++) fetch(?offset=${p * 50})` must not 400 on
 * request one.
 *
 * Number.parseInt rather than Number, matching lib/pagination.ts:49 and
 * app/api/earnings/route.ts:24. Number() also accepts `0x1f4` as 500, `1e2` as
 * 100 and " 5" as 5, none of which a caller writing a page number meant.
 */
function parseBoundedInt(
  raw: string | null,
  name: string,
  { min, max }: { min: number; max: number }
): number | null {
  if (raw === null) {
    return null;
  }
  // parseInt("12abc") is 12 and parseInt(" 5") is 5, so the string must round
  // -trip exactly - otherwise `?limit=50%20OR%201=1` reads as a plain 50, and
  // `?limit=%205` as 5. No trim: whitespace in a numeric query parameter is a
  // malformed request, not a formatting preference.
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || String(value) !== raw || value < min) {
    throw new RangeError(
      `${name} must be an integer >= ${min}`
    );
  }
  // Capped, not clamped: 1e20 survives Number.isInteger and reaches Postgres as
  // a bigint overflow, which surfaces to the caller as a raw driver message.
  if (value > max) {
    throw new RangeError(`${name} must be <= ${max}`);
  }
  return value;
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authContext = await getDualAuthContext(request, { required: false });
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { organizationId } = authContext;

    // The org owns every workflow; the list is purely org-scoped.
    if (!organizationId) {
      return NextResponse.json([], { status: 200 });
    }

    const { searchParams } = new URL(request.url);
    const projectIdFilter = searchParams.get("projectId");
    const tagIdFilter = searchParams.get("tagId");

    let limit: number | null;
    let offset: number | null;
    try {
      // Clamped below rather than rejected here, because lib/pagination.ts:53
      // clamps and X-Total-Count exists so a clamped page is detectable. The
      // ceiling passed here only rejects values too large to be a real request.
      limit = parseBoundedInt(searchParams.get("limit"), "limit", {
        min: 1,
        max: MAX_OFFSET,
      });
      offset = parseBoundedInt(searchParams.get("offset"), "offset", {
        min: 0,
        max: MAX_OFFSET,
      });
    } catch (rangeError) {
      return NextResponse.json(
        { error: (rangeError as RangeError).message },
        { status: 400 }
      );
    }

    // Offset alone is meaningless: without a limit the response is the whole
    // list either way, so a client paging by offset would re-read page one
    // forever and never learn why.
    if (offset !== null && limit === null) {
      return NextResponse.json(
        { error: "offset requires limit" },
        { status: 400 }
      );
    }

    const conditions = [eq(workflows.organizationId, organizationId)];

    if (projectIdFilter) {
      conditions.push(eq(workflows.projectId, projectIdFilter));
    }
    if (tagIdFilter) {
      conditions.push(eq(workflows.tagId, tagIdFilter));
    }

    const where = and(...conditions);

    const baseQuery = db
      .select()
      .from(workflows)
      .where(where)
      // createdAt is not unique - app/api/onboarding/recommendations hoists one
      // `new Date()` above its insert loop, so seeded rows share a timestamp
      // exactly. Without a tiebreak this is not a total order, and a row on a
      // page boundary can appear on both pages while another is skipped.
      .orderBy(asc(workflows.createdAt), asc(workflows.id));

    const map = (rows: Awaited<typeof baseQuery>) =>
      rows.map((workflow) => ({
        ...workflow,
        createdAt: workflow.createdAt.toISOString(),
        updatedAt: workflow.updatedAt.toISOString(),
      }));

    if (limit === null) {
      return NextResponse.json(map(await baseQuery));
    }

    // The response stays a bare array - an envelope here would be a breaking
    // shape change - so the total rides in a header. Without it a clamped page
    // is indistinguishable from a complete list.
    //
    // Issued together, not in sequence: the count does not depend on the page,
    // so awaiting it afterwards spent two serial round trips on one request.
    // app/api/mcp/workflows/route.ts:159 does the same.
    const [totalRow, userWorkflows] = await Promise.all([
      db.select({ value: count() }).from(workflows).where(where),
      baseQuery.limit(Math.min(limit, MAX_PAGE_SIZE)).offset(offset ?? 0),
    ]);

    return NextResponse.json(map(userWorkflows), {
      headers: { "X-Total-Count": String(totalRow[0]?.value ?? 0) },
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get workflows", error, {
      endpoint: "/api/workflows",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflows",
      },
      { status: 500 }
    );
  }
}
