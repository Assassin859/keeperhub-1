"use client";

import { Search, Workflow } from "lucide-react";
import Link from "next/link";
import type { VoteOverridesMap } from "@/components/hub/use-vote-overrides";
import { WorkflowTemplateGrid } from "@/components/hub/workflow-template-grid";
import { WorkflowTemplateList } from "@/components/hub/workflow-template-list";
import { Button } from "@/components/ui/button";
import type { SavedWorkflow } from "@/lib/api-client";
import type { VoteDirection } from "@/lib/workflow/editor/votes";

type HubResultsProps = {
  communityWorkflows: SavedWorkflow[];
  searchResults: SavedWorkflow[] | null;
  isSearchActive: boolean;
  featuredIds?: Set<string>;
  onClearFilters?: () => void;
  viewMode: "cards" | "list"; // HUB-18 — branches on cookie-driven view
  voteOverrides: VoteOverridesMap;
  onVote: (workflowId: string, direction: VoteDirection) => Promise<void>;
};

export function HubResults({
  communityWorkflows,
  searchResults,
  isSearchActive,
  featuredIds,
  onClearFilters,
  viewMode,
  voteOverrides,
  onVote,
}: HubResultsProps): React.ReactElement {
  const workflows = isSearchActive ? searchResults : communityWorkflows;

  if (!workflows || workflows.length === 0) {
    // The view-mode wrapper is kept on the empty state so its
    // `data-view-mode` attribute remains a stable selector for tests
    // (HUB-22) regardless of whether any templates have been published.
    if (isSearchActive) {
      return (
        <section
          className="flex flex-col items-center justify-center py-16 text-center"
          data-view-mode={viewMode}
        >
          <Search className="mb-3 size-8 text-muted-foreground/40" />
          <p className="mb-3 text-muted-foreground text-sm">
            No templates match your filters.
          </p>
          {onClearFilters && (
            <Button
              className="h-8 text-xs"
              onClick={onClearFilters}
              variant="outline"
            >
              Clear filters
            </Button>
          )}
        </section>
      );
    }

    return (
      <section
        className="flex flex-col items-center justify-center py-16 text-center"
        data-view-mode={viewMode}
      >
        <Workflow className="mb-3 size-8 text-muted-foreground/40" />
        <p className="mb-3 text-muted-foreground text-sm">
          No templates available yet.
        </p>
        <Button asChild className="h-8 text-xs" variant="outline">
          <Link href="/workflows/new">Create a workflow</Link>
        </Button>
      </section>
    );
  }

  if (viewMode === "list") {
    return (
      <section data-view-mode="list">
        <WorkflowTemplateList
          featuredIds={featuredIds}
          onVote={onVote}
          voteOverrides={voteOverrides}
          workflows={workflows}
        />
      </section>
    );
  }

  return (
    <section data-view-mode="cards">
      <WorkflowTemplateGrid
        featuredIds={featuredIds}
        onVote={onVote}
        voteOverrides={voteOverrides}
        workflows={workflows}
      />
    </section>
  );
}
