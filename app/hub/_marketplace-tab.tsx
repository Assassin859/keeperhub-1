import { asc, eq } from "drizzle-orm";
import { Box } from "lucide-react";
import Link from "next/link";
import { MarketplaceRow } from "@/components/hub/marketplace-row";
import {
  MarketplaceSidebar,
  type MarketplaceSidebarTag,
} from "@/components/hub/marketplace-sidebar";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { publicTags, workflowPublicTags } from "@/lib/db/schema-extensions";
import {
  fetchMarketplaceLeaderboard,
  type MarketplaceSort,
} from "@/lib/marketplace/leaderboard-query";

const VALID_SORTS: readonly MarketplaceSort[] = [
  "popular",
  "newest",
  "top-calls",
  "price",
];

async function fetchMarketplaceTags(): Promise<MarketplaceSidebarTag[]> {
  // Only surface tags that are actually used by listed workflows.
  // Showing the full public_tags taxonomy would mix in workflow-template
  // tags that have no marketplace presence (and would always return zero
  // results when clicked).
  try {
    return await db
      .selectDistinct({ name: publicTags.name, slug: publicTags.slug })
      .from(publicTags)
      .innerJoin(
        workflowPublicTags,
        eq(workflowPublicTags.publicTagId, publicTags.id)
      )
      .innerJoin(workflows, eq(workflows.id, workflowPublicTags.workflowId))
      .where(eq(workflows.isListed, true))
      .orderBy(asc(publicTags.name));
  } catch {
    return [];
  }
}

function readTag(raw: string | string[] | undefined): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readSort(raw: string | string[] | undefined): MarketplaceSort {
  if (typeof raw !== "string") {
    return "popular";
  }
  const lower = raw.toLowerCase();
  return (VALID_SORTS as readonly string[]).includes(lower)
    ? (lower as MarketplaceSort)
    : "popular";
}

function readCursor(raw: string | string[] | undefined): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

type MarketplaceTabProps = {
  searchParams: Record<string, string | string[] | undefined>;
  query: string;
};

export async function HubMarketplaceTab({
  searchParams,
  query,
}: MarketplaceTabProps): Promise<React.ReactElement> {
  const sort = readSort(searchParams.sort);
  const cursor = readCursor(searchParams.cursor);
  const tagSlug = readTag(searchParams.tag);
  const [{ rows, total }, tags] = await Promise.all([
    fetchMarketplaceLeaderboard(sort, cursor, query, tagSlug),
    fetchMarketplaceTags(),
  ]);

  const hasQuery = query.trim().length > 0;
  const hasFilter = hasQuery || tagSlug !== null;
  // Clear-filters target preserves sort (sort is a view choice, not a
  // filter) and tab. Drops q, tag, cursor.
  const clearFiltersHref = `/hub?tab=marketplace&sort=${sort}`;

  return (
    <section aria-label="Marketplace results" className="flex gap-6">
      <MarketplaceSidebar active={sort} activeTagSlug={tagSlug} tags={tags} />
      <div className="min-w-0 flex-1">
        {rows.length === 0 ? (
          <section
            aria-label="No marketplace results"
            className="flex flex-col items-center rounded-xl border border-border/30 border-dashed bg-[var(--color-hub-card)] p-12 text-center"
          >
            <Box
              aria-hidden="true"
              className="size-8 text-muted-foreground/50"
            />
            <h2 className="mt-4 font-semibold text-foreground text-sm">
              {hasFilter
                ? hasQuery
                  ? `No marketplace services match “${query}”.`
                  : "No marketplace services match this filter."
                : "No paid services listed yet."}
            </h2>
            <p className="mt-1 text-muted-foreground text-xs">
              {hasFilter
                ? "Try a different keyword or clear the filter."
                : "Listed workflows show up here once they have payment activity. List a workflow from your workflow toolbar to get started."}
            </p>
            {hasFilter && (
              <Button asChild className="mt-4 h-8 text-xs" variant="outline">
                <Link href={clearFiltersHref} scroll={false}>
                  Clear filters
                </Link>
              </Button>
            )}
          </section>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: UI-SPEC §5 mandates a CSS grid layout (grid-cols-[48px_1fr_220px_96px_96px_80px]); a native <table> cannot drive grid tracks. The role="table"/"row"/"columnheader" hierarchy preserves screen-reader semantics.
          <div
            aria-label="Marketplace leaderboard"
            aria-rowcount={total}
            className="overflow-hidden rounded-xl border border-border/20 bg-[var(--color-hub-card)]"
            role="table"
          >
            {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
            {/* biome-ignore lint/a11y/useFocusableInteractive: the header row is a label container, not a tab stop; making it focusable would create empty stops in the keyboard order. */}
            <div
              className="grid grid-cols-[48px_1fr_220px_96px_96px_80px] items-center gap-x-3 border-border/30 border-b bg-[var(--color-hub-overlay)] px-4 py-3 font-normal text-muted-foreground text-xs uppercase tracking-widest"
              role="row"
            >
              {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels; focusable headers would clutter keyboard order without adding navigation value. */}
              <span role="columnheader">Rank</span>
              {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
              <span role="columnheader">Name</span>
              {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
              <span className="hidden lg:inline" role="columnheader">
                Tags
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
              <span className="text-right" role="columnheader">
                Calls
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
              <span className="text-right" role="columnheader">
                Price
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: see role="table" justification above. */}
              {/* biome-ignore lint/a11y/useFocusableInteractive: column headers are static labels. */}
              <span className="hidden text-right md:inline" role="columnheader">
                Chain
              </span>
            </div>
            {rows.map((row, idx) => (
              <MarketplaceRow key={row.workflowId} rank={idx + 1} row={row} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
