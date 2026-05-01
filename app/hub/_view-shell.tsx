"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { HubResults } from "@/components/hub/hub-results";
import { HubSidebar, type SortValue } from "@/components/hub/hub-sidebar";
import { HubViewToggle } from "@/components/hub/hub-view-toggle";
import { useVoteOverrides } from "@/components/hub/use-vote-overrides";
import { api, type PublicTag, type SavedWorkflow } from "@/lib/api-client";
import { useDebounce } from "@/lib/hooks/use-debounce";

type ViewMode = "cards" | "list";

type HubViewShellProps = {
  initialView: ViewMode;
  initialTagSlug: string | null;
};

export default function HubViewShell({
  initialView,
  initialTagSlug,
}: HubViewShellProps): React.ReactElement {
  return (
    <Suspense>
      <HubPageContent
        initialTagSlug={initialTagSlug}
        initialView={initialView}
      />
    </Suspense>
  );
}

type HubPageContentProps = {
  initialView: ViewMode;
  initialTagSlug: string | null;
};

function HubPageContent({
  initialView,
  initialTagSlug,
}: HubPageContentProps): React.ReactElement {
  const [featuredWorkflows, setFeaturedWorkflows] = useState<SavedWorkflow[]>(
    []
  );
  const [communityWorkflows, setCommunityWorkflows] = useState<SavedWorkflow[]>(
    []
  );
  const [publicTags, setPublicTags] = useState<PublicTag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTagSlugs, setSelectedTagSlugs] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<SortValue>("top-rated");
  const [viewMode, setViewMode] = useState<ViewMode>(initialView);

  const searchParams = useSearchParams();
  // Tab-strip search (`?q=` query param) is the authoritative source for
  // the Workflows tab text filter. Mirror it into local state so the
  // existing useDebounce + filter pipeline keeps working unchanged.
  const urlQuery = searchParams.get("q") ?? "";
  const [searchQuery, setSearchQuery] = useState(urlQuery);
  useEffect(() => {
    setSearchQuery(urlQuery);
  }, [urlQuery]);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Active tag filter is driven by the ?tag= query param. The server pre-seeds
  // it via initialTagSlug so the first paint already filters; on subsequent
  // sidebar clicks <Link href="/hub?tag=…"> updates searchParams and React
  // re-renders without a route change.
  const activeTagSlug = searchParams.get("tag") ?? initialTagSlug;

  /** Merge featured + community, featured first, deduplicated (unsorted). */
  const mergedWorkflows = useMemo((): SavedWorkflow[] => {
    const seen = new Set<string>();
    const merged: SavedWorkflow[] = [];
    for (const w of featuredWorkflows) {
      if (!seen.has(w.id)) {
        seen.add(w.id);
        merged.push(w);
      }
    }
    for (const w of communityWorkflows) {
      if (!seen.has(w.id)) {
        seen.add(w.id);
        merged.push(w);
      }
    }
    return merged;
  }, [featuredWorkflows, communityWorkflows]);

  // Optimistic vote state lives at this level so (a) Top-rated sort can use
  // the effective score and (b) votes persist when toggling Cards <-> List.
  const { voteOverrides, handleVote } = useVoteOverrides(mergedWorkflows);

  const allWorkflows = useMemo((): SavedWorkflow[] => {
    const sorted = [...mergedWorkflows];
    const effectiveScore = (w: SavedWorkflow): number =>
      voteOverrides[w.id]?.score ?? w.score ?? 0;
    switch (sortBy) {
      case "most-used":
        sorted.sort((a, b) => {
          const dupDiff = (b.duplicateCount ?? 0) - (a.duplicateCount ?? 0);
          if (dupDiff !== 0) {
            return dupDiff;
          }
          return effectiveScore(b) - effectiveScore(a);
        });
        break;
      case "featured": {
        sorted.sort((a, b) => {
          const aFeat = a.featured ? 1 : 0;
          const bFeat = b.featured ? 1 : 0;
          if (aFeat !== bFeat) {
            return bFeat - aFeat;
          }
          if (a.featured && b.featured) {
            const aOrd = a.featuredOrder ?? Number.MAX_SAFE_INTEGER;
            const bOrd = b.featuredOrder ?? Number.MAX_SAFE_INTEGER;
            if (aOrd !== bOrd) {
              return aOrd - bOrd;
            }
          }
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        });
        break;
      }
      case "top-rated":
        sorted.sort((a, b) => effectiveScore(b) - effectiveScore(a));
        break;
      case "name":
        sorted.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
        break;
      default:
        break;
    }
    return sorted;
  }, [mergedWorkflows, sortBy, voteOverrides]);

  const featuredIds = useMemo(
    () => new Set(featuredWorkflows.map((w) => w.id)),
    [featuredWorkflows]
  );

  const isSearchActive = Boolean(
    debouncedSearchQuery.trim() || selectedTagSlugs.length > 0 || activeTagSlug
  );

  const searchResults = useMemo((): SavedWorkflow[] | null => {
    if (!isSearchActive) {
      return null;
    }

    const query = debouncedSearchQuery.trim().toLowerCase();
    let filtered = allWorkflows;

    // Sidebar single-tag filter (?tag=slug) takes precedence over the inline
    // multi-tag filter. Both can stack additively if a user combines them.
    if (activeTagSlug) {
      filtered = filtered.filter((w) =>
        w.publicTags?.some((t) => t.slug === activeTagSlug)
      );
    }

    if (selectedTagSlugs.length > 0) {
      filtered = filtered.filter((w) =>
        w.publicTags?.some((t) => selectedTagSlugs.includes(t.slug))
      );
    }

    if (query) {
      filtered = filtered.filter(
        (w) =>
          w.name.toLowerCase().includes(query) ||
          w.description?.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [
    isSearchActive,
    allWorkflows,
    activeTagSlug,
    selectedTagSlugs,
    debouncedSearchQuery,
  ]);

  const clearFilters = useCallback((): void => {
    setSearchQuery("");
    setSelectedTagSlugs([]);
    // Drop the sidebar single-tag filter from the URL too. Use replaceState
    // (not router.push) to keep the navigation cheap and avoid a re-render
    // round-trip — the searchParams hook still picks up the change.
    if (activeTagSlug) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("tag");
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `/hub?${qs}` : "/hub");
    }
  }, [activeTagSlug, searchParams]);

  useEffect(() => {
    const fetchWorkflows = async (): Promise<void> => {
      try {
        const [featured, community, tags] = await Promise.all([
          api.workflow.getFeatured(),
          api.workflow.getPublic(),
          api.publicTag.getAll().catch(() => [] as PublicTag[]),
        ]);
        setFeaturedWorkflows(featured);
        setCommunityWorkflows(community);
        setPublicTags(tags);
      } catch {
        // Workflow fetch failure handled by empty state
      } finally {
        setIsLoading(false);
      }
    };

    fetchWorkflows();
  }, []);

  return (
    <div data-view={viewMode}>
      {isLoading ? (
        <div className="animate-pulse pb-8">
          <div className="mb-1 h-8 w-64 rounded bg-muted/20" />
          <div className="mb-5 h-4 w-80 rounded bg-muted/10" />
          <div className="mb-4 flex justify-end">
            <div className="h-9 w-32 rounded-lg bg-muted/10" />
          </div>
          <div className="flex gap-6">
            <div className="hidden h-[400px] w-[240px] shrink-0 rounded-xl bg-muted/10 lg:block" />
            <div className="min-w-0 flex-1">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    className="h-[180px] rounded-xl bg-muted/10"
                    key={`card-${String(i)}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="pb-8">
          {/* Phase 44 plan 44-09: HubHero is now mounted in app/hub/page.tsx
              above the tab strip — a single hero for all three tabs.
              Workflows-tab body starts directly with the view toggle. */}
          <div className="mb-4 flex justify-end">
            <HubViewToggle initialView={initialView} onChange={setViewMode} />
          </div>

          <div className="flex gap-6">
            <HubSidebar
              activeTagSlug={activeTagSlug}
              onSortChange={setSortBy}
              publicTags={publicTags}
              sortBy={sortBy}
            />

            <div className="min-w-0 flex-1">
              <HubResults
                communityWorkflows={allWorkflows}
                featuredIds={featuredIds}
                isSearchActive={isSearchActive}
                onClearFilters={clearFilters}
                onVote={handleVote}
                searchResults={searchResults}
                viewMode={viewMode}
                voteOverrides={voteOverrides}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
