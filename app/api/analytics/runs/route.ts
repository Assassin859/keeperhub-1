import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getUnifiedRuns } from "@/lib/analytics/queries";
import { parseTimeRange } from "@/lib/analytics/time-range";
import type { NormalizedStatus, RunSource } from "@/lib/analytics/types";
import { apiError } from "@/lib/api-error";
import { requireOrganization } from "@/lib/middleware/require-org";

const VALID_STATUSES = new Set<NormalizedStatus>([
  "pending",
  "running",
  "success",
  "error",
  "cancelled",
]);

const VALID_SOURCES = new Set<RunSource>(["workflow", "direct"]);

export const GET = requireOrganization(
  async (req: NextRequest, context): Promise<Response> => {
    try {
      const organizationId = context.organization?.id;
      if (!organizationId) {
        return NextResponse.json(
          { error: "No active organization" },
          { status: 400 }
        );
      }

      const params = req.nextUrl.searchParams;
      const range = parseTimeRange(params.get("range"));
      const customStart = params.get("customStart") ?? undefined;
      const customEnd = params.get("customEnd") ?? undefined;
      const cursor = params.get("cursor") ?? undefined;

      const pageParam = params.get("page");
      const page = pageParam ? Math.max(1, Number(pageParam)) : undefined;

      const limitParam = params.get("limit");
      const limit = limitParam ? Number(limitParam) : undefined;

      const statusParam = params.get("status");
      const status =
        statusParam && VALID_STATUSES.has(statusParam as NormalizedStatus)
          ? (statusParam as NormalizedStatus)
          : undefined;

      const sourceParam = params.get("source");
      const source =
        sourceParam && VALID_SOURCES.has(sourceParam as RunSource)
          ? (sourceParam as RunSource)
          : undefined;

      const projectId = params.get("projectId") ?? undefined;

      const result = await getUnifiedRuns(organizationId, range, {
        cursor,
        page,
        limit,
        status,
        source,
        customStart,
        customEnd,
        projectId,
      });

      return NextResponse.json(result);
    } catch (error: unknown) {
      return apiError(error, "Failed to fetch analytics runs");
    }
  }
);
