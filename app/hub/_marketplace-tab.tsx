import { Box } from "lucide-react";
import { MarketplaceRow } from "@/components/hub/marketplace-row";
import { MarketplaceSortDropdown } from "@/components/hub/marketplace-sort-dropdown";
import {
  fetchMarketplaceLeaderboard,
  type MarketplaceSort,
} from "@/lib/marketplace/leaderboard-query";

const VALID_SORTS: readonly MarketplaceSort[] = [
  "popular",
  "newest",
  "top-calls",
];

const SORT_LABELS: Record<MarketplaceSort, string> = {
  popular: "Popular",
  newest: "Newest",
  "top-calls": "Top calls",
};

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
  const { rows, total } = await fetchMarketplaceLeaderboard(
    sort,
    cursor,
    query
  );

  if (rows.length === 0) {
    const hasQuery = query.trim().length > 0;
    return (
      <section
        aria-label="Marketplace results"
        className="flex flex-col items-center rounded-xl border border-border/30 border-dashed bg-[var(--color-hub-card)] p-12 text-center"
      >
        <Box aria-hidden="true" className="size-8 text-muted-foreground/50" />
        <h2 className="mt-4 font-semibold text-foreground text-sm">
          {hasQuery
            ? `No marketplace services match “${query}”.`
            : "No paid services listed yet."}
        </h2>
        <p className="mt-1 text-muted-foreground text-xs">
          {hasQuery
            ? "Try a different keyword or clear the search."
            : "Listed workflows show up here once they have payment activity. List a workflow from your workflow toolbar to get started."}
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Marketplace results">
      <div className="mb-4 flex items-center justify-between">
        <p
          aria-live="polite"
          className="text-muted-foreground text-xs"
        >{`Showing 1–${rows.length} of ${total}, sorted by ${SORT_LABELS[sort]}`}</p>
        <MarketplaceSortDropdown active={sort} />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: UI-SPEC §5 mandates a CSS grid layout (grid-cols-[48px_1fr_220px_96px_96px_80px]); a native <table> cannot drive grid tracks. The role="table"/"row"/"columnheader" hierarchy preserves screen-reader semantics. */}
      <div
        aria-label="Marketplace leaderboard"
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
          <span className="hidden md:inline" role="columnheader">
            Chain
          </span>
        </div>
        {rows.map((row, idx) => (
          <MarketplaceRow key={row.workflowId} rank={idx + 1} row={row} />
        ))}
      </div>
    </section>
  );
}
