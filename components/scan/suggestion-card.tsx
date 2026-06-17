"use client";

import type { KeyboardEvent } from "react";
import { getChainName } from "@/lib/chain-utils";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import { CategoryBadge } from "./category-badge";
import { ReadWritePill } from "./read-write-pill";

type SuggestionCardProps = {
  suggestion: SuggestionDescriptor;
  onSelect: (suggestion: SuggestionDescriptor) => void;
};

export function SuggestionCard({
  suggestion,
  onSelect,
}: SuggestionCardProps): React.ReactElement {
  const handleClick = (): void => {
    onSelect(suggestion);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(suggestion);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: card uses an <article> with role="link" + ::before overlay per UI-SPEC §1; wrapping <a> is forbidden to preserve nested-button a11y
    <article
      aria-label={`Open ${suggestion.name} preview`}
      className="group relative flex min-h-[160px] cursor-pointer flex-col rounded-xl border border-border/20 bg-[var(--color-hub-card)] p-4 shadow-sm transition-colors duration-150 before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:rounded-xl before:content-[''] hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-hub-overlay)] motion-reduce:transition-none"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: card uses article role="link" per UI-SPEC §1; click is delivered via the ::before overlay and onKeyDown handler
      role="link"
      tabIndex={0}
    >
      <div className="pointer-events-none relative z-[2]">
        <CategoryBadge category={suggestion.category} />
      </div>
      <h3 className="pointer-events-none relative z-[2] mt-2 line-clamp-2 font-semibold text-foreground text-sm">
        {suggestion.name}
      </h3>
      <p className="pointer-events-none relative z-[2] mt-1 line-clamp-3 text-muted-foreground/80 text-xs leading-normal">
        {suggestion.description}
      </p>
      <div className="pointer-events-none relative z-[2] mt-auto flex items-center gap-3 pt-3">
        <span className="text-muted-foreground text-xs">
          {getChainName(String(suggestion.chainId))}
        </span>
        <ReadWritePill value={suggestion.readOrWrite} />
      </div>
      <p className="pointer-events-none relative z-[2] mt-2 line-clamp-2 text-muted-foreground/70 text-xs leading-relaxed">
        {suggestion.riskNote}
      </p>
    </article>
  );
}
