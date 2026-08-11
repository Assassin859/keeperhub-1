import { and, asc, count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

/**
 * Upper bound on an explicitly requested page. `?limit=1000000` should not be
 * a way to ask for the unbounded response by another name.
 */
const MAX_PAGE_SIZE = 500;

/** A positive integer, or null when the parameter was absent. Throws on junk. */
function parsePositiveInt(raw: string | null, name: string): number | null {
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  // Number("") is 0 and Number("abc") is NaN. Treating either as "unset" is how
  // `?limit=${undefined}` from a client mid-migration would silently return
  // every row in the org - the case MAX_PAGE_SIZE exists to prevent.
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
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
      limit = parsePositiveInt(searchParams.get("limit"), "limit");
      offset = parsePositiveInt(searchParams.get("offset"), "offset");
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

    const userWorkflows =
      limit === null
        ? await baseQuery
        : await baseQuery
            .limit(Math.min(limit, MAX_PAGE_SIZE))
            .offset(offset ?? 0);

    const mappedWorkflows = userWorkflows.map((workflow) => ({
      ...workflow,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    }));

    if (limit === null) {
      return NextResponse.json(mappedWorkflows);
    }

    // The response stays a bare array - an envelope here would be a breaking
    // shape change - so the total rides in a header. Without it a clamped page
    // is indistinguishable from a complete list.
    const [totalRow] = await db
      .select({ value: count() })
      .from(workflows)
      .where(where);

    return NextResponse.json(mappedWorkflows, {
      headers: { "X-Total-Count": String(totalRow?.value ?? 0) },
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
