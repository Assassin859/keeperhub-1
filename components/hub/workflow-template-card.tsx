"use client";

import { ArrowBigDown, ArrowBigUp, Copy, Eye, Star } from "lucide-react";
import type { MouseEvent } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SavedWorkflow } from "@/lib/api-client";
import type { VoteDirection } from "@/lib/workflow/votes";
import { WorkflowMiniMap } from "./workflow-mini-map";

type WorkflowTemplateCardProps = {
  workflow: SavedWorkflow;
  isDuplicating: boolean;
  isFeatured?: boolean;
  score?: number;
  userVote?: VoteDirection | null;
  className?: string;
  onDuplicate: (e: MouseEvent) => void;
  onPreview: (e: MouseEvent) => void;
  onVote?: (direction: VoteDirection) => void;
};

function voteColorClass(userVote: VoteDirection | null): string {
  if (userVote === "upvote") {
    return "text-green-400";
  }
  if (userVote === "downvote") {
    return "text-red-400";
  }
  return "text-muted-foreground";
}

function scoreColorClass(score: number): string {
  if (score > 0) {
    return "text-green-400/80";
  }
  if (score < 0) {
    return "text-red-400/80";
  }
  return "text-muted-foreground";
}

function VoteButtons({
  score,
  userVote,
  onVote,
}: {
  score: number;
  userVote: VoteDirection | null;
  onVote: (direction: VoteDirection) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-0.5">
      <button
        aria-label="Upvote"
        className={`rounded p-0.5 transition-colors duration-150 ${
          userVote === "upvote"
            ? "text-green-400"
            : "text-muted-foreground/50 hover:text-green-400"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onVote("upvote");
        }}
        type="button"
      >
        <ArrowBigUp
          className={`size-4 ${userVote === "upvote" ? "fill-green-400" : ""}`}
        />
      </button>
      <span
        className={`min-w-[1rem] text-center font-medium text-[11px] tabular-nums transition-colors duration-150 ${voteColorClass(userVote)}`}
      >
        {score}
      </span>
      <button
        aria-label="Downvote"
        className={`rounded p-0.5 transition-colors duration-150 ${
          userVote === "downvote"
            ? "text-red-400"
            : "text-muted-foreground/50 hover:text-red-400"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onVote("downvote");
        }}
        type="button"
      >
        <ArrowBigDown
          className={`size-4 ${userVote === "downvote" ? "fill-red-400" : ""}`}
        />
      </button>
    </div>
  );
}

export function WorkflowTemplateCard({
  workflow,
  isDuplicating,
  isFeatured = false,
  score = 0,
  userVote = null,
  className,
  onDuplicate,
  onPreview,
  onVote,
}: WorkflowTemplateCardProps): React.ReactElement {
  return (
    <article
      className={`group relative flex flex-col overflow-hidden rounded-xl border border-border/20 bg-[var(--color-hub-card)] transition-all duration-200 hover:border-border/50 hover:shadow-[0_0_20px_rgba(9,253,103,0.03)] motion-reduce:transition-none ${className ?? "aspect-square"}`}
    >
      <div className="relative flex flex-1 flex-col p-4">
        <div className="shrink-0">
          <div className="flex items-start gap-1.5">
            <h3 className="line-clamp-2 flex-1 font-semibold text-sm leading-snug">
              {workflow.name}
            </h3>
            {score !== 0 && (
              <div className="flex h-[20px] shrink-0 items-center gap-0.5">
                <ArrowBigUp
                  className={`size-3 ${score > 0 ? "fill-green-400/60 text-green-400" : "text-muted-foreground/40"}`}
                />
                <span
                  className={`font-medium text-[11px] tabular-nums ${scoreColorClass(score)}`}
                >
                  {score}
                </span>
              </div>
            )}
            {isFeatured && (
              <span className="inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-accent)] px-2">
                <Star className="size-2.5 fill-[var(--color-text-accent)] text-[var(--color-text-accent)]" />
                <span className="font-medium text-[var(--color-text-accent)] text-[10px]">
                  Featured
                </span>
              </span>
            )}
          </div>
          {workflow.description && (
            <p className="mt-1.5 line-clamp-3 text-muted-foreground/80 text-xs leading-relaxed">
              {workflow.description}
            </p>
          )}
        </div>

        <div className="pointer-events-none my-auto shrink opacity-30 transition-opacity duration-200 group-hover:opacity-50">
          <WorkflowMiniMap
            edges={workflow.edges}
            height={160}
            nodes={workflow.nodes}
            width={280}
          />
        </div>

        {workflow.publicTags && workflow.publicTags.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-1">
            {workflow.publicTags.slice(0, 3).map((tag) => (
              <span
                className="rounded-full bg-[var(--color-hub-icon-bg)] px-2 py-0.5 text-muted-foreground text-[10px]"
                key={tag.slug}
              >
                {tag.name}
              </span>
            ))}
            {workflow.publicTags.length > 3 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default rounded-full bg-[var(--color-hub-icon-bg)] px-1.5 py-0.5 text-muted-foreground text-[10px]">
                    +{workflow.publicTags.length - 3}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="flex flex-col gap-0.5" side="bottom">
                  {workflow.publicTags.map((tag) => (
                    <span className="text-xs" key={tag.slug}>
                      {tag.name}
                    </span>
                  ))}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-[var(--color-hub-card)] via-[var(--color-hub-card)] via-60% to-transparent opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100 motion-reduce:transition-none">
        <div className="flex w-full items-center gap-2 p-4 pt-12">
          <button
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-text-accent)] font-medium text-[#0a0f14] text-xs transition-colors hover:bg-[var(--color-text-accent)]/90 disabled:opacity-50"
            disabled={isDuplicating}
            onClick={onDuplicate}
            type="button"
          >
            <Copy className="size-3" />
            {isDuplicating ? "Duplicating..." : "Use Template"}
          </button>
          <button
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border/50 bg-[var(--color-hub-icon-bg)] px-3 text-muted-foreground text-xs transition-colors hover:border-border hover:text-foreground"
            onClick={onPreview}
            type="button"
          >
            <Eye className="size-3" />
            Preview
          </button>
          {onVote && (
            <VoteButtons onVote={onVote} score={score} userVote={userVote} />
          )}
        </div>
      </div>
    </article>
  );
}
