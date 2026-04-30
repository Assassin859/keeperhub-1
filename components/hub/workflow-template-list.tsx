"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import type { SavedWorkflow } from "@/lib/api-client";
import type { VoteDirection } from "@/lib/workflow/editor/votes";
import type { VoteOverridesMap } from "./use-vote-overrides";
import { WorkflowTemplateRow } from "./workflow-template-row";

type WorkflowTemplateListProps = {
  workflows: SavedWorkflow[];
  featuredIds?: Set<string>;
  voteOverrides: VoteOverridesMap;
  onVote: (workflowId: string, direction: VoteDirection) => Promise<void>;
};

export function WorkflowTemplateList({
  workflows,
  featuredIds,
  voteOverrides,
  onVote,
}: WorkflowTemplateListProps): React.ReactElement | null {
  const router = useRouter();

  const handlePreview = (e: MouseEvent, workflowId: string): void => {
    e.stopPropagation();
    router.push(`/workflows/${workflowId}`);
  };

  if (workflows.length === 0) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: rowgroup A11y wrapper without using a real <table> -- the rows inside are <article role="row"> per UI-SPEC §2; <tbody> would not be a valid parent for <article>.
    <div
      className="overflow-hidden rounded-xl border border-border/20"
      role="rowgroup"
    >
      {workflows.map((workflow) => {
        const override = voteOverrides[workflow.id];
        return (
          <WorkflowTemplateRow
            isFeatured={featuredIds?.has(workflow.id) ?? false}
            key={workflow.id}
            onPreview={(e) => handlePreview(e, workflow.id)}
            onVote={(direction) => onVote(workflow.id, direction)}
            score={override?.score ?? workflow.score ?? 0}
            userVote={
              override ? override.userVote : (workflow.userVote ?? null)
            }
            workflow={workflow}
          />
        );
      })}
    </div>
  );
}
