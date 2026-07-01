import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";

const CHIP_SLUGS = [
  "aave-health",
  "whale-withdrawal",
  "governance",
  "sky-staking",
  "steth-wrap",
  "usds-savings",
] as const;

/**
 * GET /api/onboarding/recommendations
 *
 * Returns a map of chip slug -> workflow id for each onboarding hub workflow
 * that has been seeded into the database. Public endpoint — the workflows are
 * already visibility=public so revealing their ids is fine.
 *
 * Response: { [chipSlug: string]: string }
 * Missing slugs (not yet seeded) are omitted from the response.
 */
export async function GET(): Promise<NextResponse> {
  const rows = await db
    .select({ id: workflows.id, listedSlug: workflows.listedSlug })
    .from(workflows)
    .where(
      and(
        inArray(workflows.listedSlug, [...CHIP_SLUGS]),
        isNull(workflows.deletedAt),
        isNotNull(workflows.listedSlug)
      )
    );

  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.listedSlug) {
      map[row.listedSlug] = row.id;
    }
  }

  return NextResponse.json(map, {
    headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
  });
}
