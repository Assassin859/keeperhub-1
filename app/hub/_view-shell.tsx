"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { HubHero } from "@/components/hub/hub-hero";
import { HubResults } from "@/components/hub/hub-results";
import { HubSidebar, type SortValue } from "@/components/hub/hub-sidebar";
import { HubViewToggle } from "@/components/hub/hub-view-toggle";
import { ProtocolDetailModal } from "@/components/hub/protocol-detail-modal";
import { ProtocolStrip } from "@/components/hub/protocol-strip";
import { useVoteOverrides } from "@/components/hub/use-vote-overrides";
import { api, type PublicTag, type SavedWorkflow } from "@/lib/api-client";
import { useDebounce } from "@/lib/hooks/use-debounce";
import type { ProtocolDefinition } from "@/lib/protocol-registry";

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
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTagSlugs, setSelectedTagSlugs] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<SortValue>("top-rated");
  const [viewMode, setViewMode] = useState<ViewMode>(initialView);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  const [protocols, setProtocols] = useState<ProtocolDefinition[]>([]);
  const searchParams = useSearchParams();
  const [selectedProtocolSlug, setSelectedProtocolSlug] = useState<
    string | null
  >(searchParams.get("protocol"));

  // Active tag filter is driven by the ?tag= query param. The server pre-seeds
  // it via initialTagSlug so the first paint already filters; on subsequent
  // sidebar clicks <Link href="/hub?tag=…"> updates searchParams and React
  // re-renders without a route change.
  const activeTagSlug = searchParams.get("tag") ?? initialTagSlug;

  const selectedProtocol = useMemo(
    () => protocols.find((p) => p.slug === selectedProtocolSlug) ?? null,
    [protocols, selectedProtocolSlug]
  );

  const handleProtocolSelect = useCallback(
    (slug: string): void => {
      setSelectedProtocolSlug(slug);
      const params = new URLSearchParams(searchParams.toString());
      params.set("protocol", slug);
      window.history.replaceState(null, "", `/hub?${params.toString()}`);
    },
    [searchParams]
  );

  const clearProtocolSelection = useCallback((): void => {
    setSelectedProtocolSlug(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("protocol");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `/hub?${qs}` : "/hub");
  }, [searchParams]);

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

  useEffect(() => {
    const fetchProtocols = async (): Promise<void> => {
      try {
        const res = await fetch("/api/protocols");
        if (res.ok) {
          const data: ProtocolDefinition[] = await res.json();
          setProtocols(data);
        }
      } catch {
        // Protocol fetch failure should not block the Hub
      }
    };

    fetchProtocols();
  }, []);

  return (
    <div
      className="pointer-events-auto fixed inset-0 overflow-x-hidden overflow-y-auto bg-sidebar [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-view={viewMode}
    >
      <div className="flex min-h-full flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        {isLoading ? (
          <div className="container mx-auto max-w-7xl animate-pulse px-6 pt-20 pb-8">
            <div className="mb-1 h-8 w-64 rounded bg-muted/20" />
            <div className="mb-5 h-4 w-80 rounded bg-muted/10" />
            <div className="mb-8 h-10 w-96 rounded-lg bg-muted/10" />
            <div className="mb-6 flex gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  className="h-9 w-28 rounded-lg bg-muted/10"
                  key={`proto-${String(i)}`}
                />
              ))}
            </div>
            <div className="mt-6 mb-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-border/30" />
              <div className="h-3 w-20 rounded bg-muted/10" />
              <div className="h-px flex-1 bg-border/30" />
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
          <div className="container mx-auto max-w-7xl px-6 pt-20 pb-8">
            <HubHero
              onSearchChange={setSearchQuery}
              searchQuery={searchQuery}
            />

            {protocols.length > 0 && (
              <ProtocolStrip
                onSelect={handleProtocolSelect}
                protocols={protocols}
              />
            )}

            <div className="mt-6 mb-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-border/30" />
              <h2 className="shrink-0 text-[var(--color-text-accent)]/60 text-xs uppercase tracking-widest">
                Templates
              </h2>
              <div className="h-px flex-1 bg-border/30" />
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

            <ProtocolDetailModal
              onOpenChange={(open) => {
                if (!open) {
                  clearProtocolSelection();
                }
              }}
              open={selectedProtocolSlug !== null}
              protocol={selectedProtocol}
            />
          </div>
        )}
      </div>
    </div>
  );
}
