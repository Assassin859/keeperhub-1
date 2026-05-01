"use client";

import {
  ArrowBigDown,
  ArrowBigUp,
  Star,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { SavedWorkflow } from "@/lib/api-client";
import type { VoteDirection } from "@/lib/workflow/editor/votes";

type WorkflowTemplateRowProps = {
  workflow: SavedWorkflow;
  isFeatured?: boolean;
  score?: number;
  userVote?: VoteDirection | null;
  onPreview: (e: MouseEvent) => void;
  onVote?: (direction: VoteDirection) => void;
};

function voteCountColorClass(userVote: VoteDirection | null): string {
  if (userVote === "upvote") {
    return "text-[var(--color-text-accent)]";
  }
  if (userVote === "downvote") {
    return "text-[var(--color-text-error)]";
  }
  return "text-muted-foreground";
}

function priceLabel(workflow: SavedWorkflow): string | null {
  if (!workflow.isListed) {
    return null;
  }
  const raw = workflow.priceUsdcPerCall;
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) {
    return null;
  }
  return `$${num.toFixed(2)}/call`;
}

export function WorkflowTemplateRow({
  workflow,
  isFeatured = false,
  score = 0,
  userVote = null,
  onPreview,
  onVote,
}: WorkflowTemplateRowProps): React.ReactElement {
  const handleClick = (e: MouseEvent<HTMLElement>): void => {
    onPreview(e);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPreview(e as unknown as MouseEvent);
    }
  };

  const price = priceLabel(workflow);
  const upActive = userVote === "upvote";
  const downActive = userVote === "downvote";

  return (
    // biome-ignore lint/a11y/useSemanticElements: row uses an <article> with the row A11y role per UI-SPEC §2 to act as a click target with the ::before overlay; nested vote buttons forbid wrapping <a>.
    <article
      aria-label={`Open ${workflow.name} preview`}
      className="group relative flex min-h-[3rem] cursor-pointer items-center gap-3 bg-[var(--color-hub-card)] px-4 py-3 transition-colors duration-100 ease before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:content-[''] even:bg-[var(--color-row-stripe)] hover:bg-[var(--color-hub-icon-bg)] motion-reduce:transition-none"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: UI-SPEC §2 mandates an <article> with the row A11y role for rowgroup/row semantics; the row is interactive via the ::before overlay and onKeyDown handler.
      role="row"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none relative z-[2] inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-hub-icon-bg)] text-muted-foreground"
      >
        <WorkflowIcon className="size-3.5" />
      </span>

      <span className="pointer-events-none relative z-[2] flex-1 truncate font-semibold text-foreground text-sm">
        {workflow.name}
      </span>

      {workflow.publicTags && workflow.publicTags.length > 0 && (
        <div className="pointer-events-none relative z-[2] hidden shrink-0 gap-1 lg:flex">
          {workflow.publicTags.slice(0, 3).map((tag) => (
            <span
              className="rounded-full bg-[var(--color-hub-icon-bg)] px-2 py-0.5 font-normal text-[0.625rem] text-muted-foreground"
              key={tag.slug}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}

      {price && (
        <span className="pointer-events-none relative z-[2] shrink-0 font-semibold text-foreground text-xs tabular-nums">
          {price}
        </span>
      )}

      {/* MARKETPLACE_BADGE_SLOT: reserved for cross-tab discovery — Phase 44 HUBV2-08 explicitly forbids rendering anything here. Tab-strip is the only cross-tab discovery mechanism. */}

      {isFeatured && (
        <span className="pointer-events-none relative z-[2] inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-accent)] px-2">
          <Star className="size-2.5 fill-[var(--color-text-accent)] text-[var(--color-text-accent)]" />
          <span className="font-normal text-[0.625rem] text-[var(--color-text-accent)]">
            Featured
          </span>
        </span>
      )}

      {onVote && (
        <div className="pointer-events-auto relative z-[2] flex shrink-0 items-center gap-0.5">
          <button
            aria-label="Upvote"
            aria-pressed={upActive}
            className={`rounded p-0.5 transition-colors duration-150 motion-reduce:transition-none ${
              upActive
                ? "cursor-default text-[var(--color-text-accent)]"
                : "text-muted-foreground/50 hover:text-[var(--color-text-accent)]"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (upActive) {
                return;
              }
              onVote("upvote");
            }}
            type="button"
          >
            <ArrowBigUp
              className={`size-4 ${upActive ? "fill-[var(--color-text-accent)]" : ""}`}
            />
          </button>
          <span
            aria-label={`Vote score ${score}`}
            className={`min-w-[1rem] text-center font-semibold text-[0.6875rem] tabular-nums ${voteCountColorClass(userVote)}`}
            role="status"
          >
            {score}
          </span>
          <button
            aria-label="Downvote"
            aria-pressed={downActive}
            className={`rounded p-0.5 transition-colors duration-150 motion-reduce:transition-none ${
              downActive
                ? "cursor-default text-[var(--color-text-error)]"
                : "text-muted-foreground/50 hover:text-[var(--color-text-error)]"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (downActive) {
                return;
              }
              onVote("downvote");
            }}
            type="button"
          >
            <ArrowBigDown
              className={`size-4 ${downActive ? "fill-[var(--color-text-error)]" : ""}`}
            />
          </button>
        </div>
      )}
    </article>
  );
}
