"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { HubHero } from "@/components/hub/hub-hero";
import { HubResults } from "@/components/hub/hub-results";
import { ProtocolDetailModal } from "@/components/hub/protocol-detail-modal";
import { ProtocolStrip } from "@/components/hub/protocol-strip";
import { WorkflowSearchFilter } from "@/components/hub/workflow-search-filter";
import { api, type PublicTag, type SavedWorkflow } from "@/lib/api-client";
import { useDebounce } from "@/lib/hooks/use-debounce";
import type { ProtocolDefinition } from "@/lib/protocol-registry";

export default function HubPage(): React.ReactElement {
  return (
    <Suspense>
      <HubPageContent />
    </Suspense>
  );
}

function HubPageContent(): React.ReactElement {
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
  const [sortBy, setSortBy] = useState<"recent" | "votes">("recent");
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  const [protocols, setProtocols] = useState<ProtocolDefinition[]>([]);
  const searchParams = useSearchParams();
  const [selectedProtocolSlug, setSelectedProtocolSlug] = useState<
    string | null
  >(searchParams.get("protocol"));

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

  /** Merge featured + community, featured first, deduplicated */
  const allWorkflows = useMemo((): SavedWorkflow[] => {
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
    if (sortBy === "votes") {
      merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }
    return merged;
  }, [featuredWorkflows, communityWorkflows, sortBy]);

  const featuredIds = useMemo(
    () => new Set(featuredWorkflows.map((w) => w.id)),
    [featuredWorkflows]
  );

  const isSearchActive = Boolean(
    debouncedSearchQuery.trim() || selectedTagSlugs.length > 0
  );

  const searchResults = useMemo((): SavedWorkflow[] | null => {
    if (!isSearchActive) {
      return null;
    }

    const query = debouncedSearchQuery.trim().toLowerCase();
    let filtered = allWorkflows;

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
  }, [isSearchActive, allWorkflows, selectedTagSlugs, debouncedSearchQuery]);

  const handleToggleTag = (slug: string): void => {
    setSelectedTagSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const clearFilters = useCallback((): void => {
    setSearchQuery("");
    setSelectedTagSlugs([]);
  }, []);

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
    <div className="pointer-events-auto fixed inset-0 overflow-x-hidden overflow-y-auto bg-sidebar [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-h-full flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        {isLoading ? (
          <div className="container mx-auto max-w-7xl px-6 pt-20 pb-8 animate-pulse">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  className="h-[180px] rounded-xl bg-muted/10"
                  key={`card-${String(i)}`}
                />
              ))}
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

            <div className="mt-4 mb-4">
              <div className="mb-4">
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border/30" />
                  <h2 className="shrink-0 text-[var(--color-text-accent)]/60 text-xs uppercase tracking-widest">
                    Templates
                  </h2>
                  <div className="h-px flex-1 bg-border/30" />
                  <div className="flex shrink-0 gap-1 rounded-lg border border-border/30 p-0.5">
                    <button
                      className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${sortBy === "recent" ? "bg-[var(--color-hub-icon-bg)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setSortBy("recent")}
                      type="button"
                    >
                      Recent
                    </button>
                    <button
                      className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${sortBy === "votes" ? "bg-[var(--color-hub-icon-bg)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setSortBy("votes")}
                      type="button"
                    >
                      Top voted
                    </button>
                  </div>
                </div>

                <WorkflowSearchFilter
                  onTagToggle={handleToggleTag}
                  publicTags={publicTags}
                  selectedTagSlugs={selectedTagSlugs}
                />
              </div>

              <HubResults
                communityWorkflows={allWorkflows}
                featuredIds={featuredIds}
                isSearchActive={isSearchActive}
                onClearFilters={clearFilters}
                searchResults={searchResults}
              />
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
