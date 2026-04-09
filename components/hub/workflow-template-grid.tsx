"use client";

import { useRouter } from "next/navigation";
import { type MouseEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { api, type SavedWorkflow, type VoteResponse } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import type { VoteDirection } from "@/lib/workflow/votes";
import { WorkflowTemplateCard } from "./workflow-template-card";

type WorkflowTemplateGridProps = {
  workflows: SavedWorkflow[];
  featuredIds?: Set<string>;
};

type VoteOverride = {
  score: number;
  userVote: VoteDirection | null;
};

function voteValue(direction: VoteDirection): number {
  return direction === "upvote" ? 1 : -1;
}

function computeOptimisticVote(
  currentScore: number,
  currentVote: VoteDirection | null,
  direction: VoteDirection
): VoteOverride {
  if (currentVote === direction) {
    // Toggle off
    return { score: currentScore - voteValue(direction), userVote: null };
  }
  if (currentVote === null) {
    // New vote
    return { score: currentScore + voteValue(direction), userVote: direction };
  }
  // Switch direction
  return {
    score: currentScore - voteValue(currentVote) + voteValue(direction),
    userVote: direction,
  };
}

export function WorkflowTemplateGrid({
  workflows,
  featuredIds,
}: WorkflowTemplateGridProps): React.ReactElement | null {
  const router = useRouter();
  const { data: session } = useSession();
  const [duplicatingIds, setDuplicatingIds] = useState<Set<string>>(new Set());
  const [voteOverrides, setVoteOverrides] = useState<
    Record<string, VoteOverride>
  >({});

  const handleDuplicate = async (
    e: MouseEvent,
    workflowId: string
  ): Promise<void> => {
    e.stopPropagation();

    if (duplicatingIds.has(workflowId)) {
      return;
    }

    setDuplicatingIds((prev) => new Set(prev).add(workflowId));

    try {
      if (!session?.user) {
        await authClient.signIn.anonymous();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const duplicated = await api.workflow.duplicate(workflowId);
      refetchSidebar();
      toast.success("Template duplicated");
      router.push(`/workflows/${duplicated.id}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to duplicate"
      );
    } finally {
      setDuplicatingIds((prev) => {
        const next = new Set(prev);
        next.delete(workflowId);
        return next;
      });
    }
  };

  const handlePreview = (e: MouseEvent, workflowId: string): void => {
    e.stopPropagation();
    router.push(`/workflows/${workflowId}`);
  };

  const handleVote = useCallback(
    async (workflowId: string, direction: VoteDirection): Promise<void> => {
      if (!session?.user) {
        toast.error("Sign in to vote on workflows");
        return;
      }

      const workflow = workflows.find((w) => w.id === workflowId);

      if (!workflow?.canVote) {
        toast.error("Use this template first to vote");
        return;
      }

      // Capture pre-optimistic state for revert
      let snapshotVote: VoteDirection | null = null;
      let snapshotScore = 0;

      setVoteOverrides((prev) => {
        const override = prev[workflowId];
        snapshotVote = override?.userVote ?? workflow?.userVote ?? null;
        snapshotScore = override?.score ?? workflow?.score ?? 0;
        return {
          ...prev,
          [workflowId]: computeOptimisticVote(
            snapshotScore,
            snapshotVote,
            direction
          ),
        };
      });

      try {
        const result: VoteResponse = await api.workflow.voteWorkflow(
          workflowId,
          direction
        );
        setVoteOverrides((prev) => ({
          ...prev,
          [workflowId]: { score: result.score, userVote: result.userVote },
        }));
      } catch (error) {
        setVoteOverrides((prev) => ({
          ...prev,
          [workflowId]: { score: snapshotScore, userVote: snapshotVote },
        }));
        toast.error(error instanceof Error ? error.message : "Failed to vote");
      }
    },
    [session, workflows]
  );

  if (workflows.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {workflows.map((workflow) => {
        const override = voteOverrides[workflow.id];
        return (
          <WorkflowTemplateCard
            isDuplicating={duplicatingIds.has(workflow.id)}
            isFeatured={featuredIds?.has(workflow.id) ?? false}
            key={workflow.id}
            onDuplicate={(e) => handleDuplicate(e, workflow.id)}
            onPreview={(e) => handlePreview(e, workflow.id)}
            onVote={(direction) => handleVote(workflow.id, direction)}
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
