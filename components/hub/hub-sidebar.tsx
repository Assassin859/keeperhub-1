"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { PublicTag } from "@/lib/api-client";

type SortValue = "recent" | "votes";

type HubSidebarProps = {
  publicTags: PublicTag[];
  sortBy: SortValue;
  onSortChange: (next: SortValue) => void;
};

const SORT_OPTIONS: ReadonlyArray<{ value: SortValue; label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "votes", label: "Top voted" },
] as const;

type SectionHeaderProps = {
  label: string;
  count?: number;
};

function SectionHeader({
  label,
  count,
}: SectionHeaderProps): React.ReactElement {
  return (
    <CollapsibleTrigger asChild>
      <button
        className="group flex w-full items-center justify-between rounded-md px-3 py-2 font-normal text-muted-foreground text-xs uppercase tracking-widest transition-colors duration-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none"
        type="button"
      >
        <span className="inline-flex items-center gap-2">
          {label}
          {typeof count === "number" && (
            <span className="font-normal normal-case text-muted-foreground/60 tracking-normal">
              ({count})
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-200 group-data-[state=closed]:-rotate-90 motion-reduce:transition-none"
        />
      </button>
    </CollapsibleTrigger>
  );
}

function getActiveTagSlug(pathname: string): string | null {
  if (!pathname.startsWith("/hub/tags/")) {
    return null;
  }
  const rest = pathname.slice("/hub/tags/".length);
  const firstSegment = rest.split("/")[0] ?? "";
  if (firstSegment === "") {
    return null;
  }
  try {
    return decodeURIComponent(firstSegment);
  } catch {
    return firstSegment;
  }
}

export function HubSidebar({
  publicTags,
  sortBy,
  onSortChange,
}: HubSidebarProps): React.ReactElement {
  const pathname = usePathname() ?? "/hub";
  const activeTagSlug = getActiveTagSlug(pathname);

  // First-paint defaults are owned locally so the navigation-sidebar's
  // global panels.sort/panels.tags state (which both default to "closed"
  // for the nav sidebar UX) does not bleed through to the Hub sidebar.
  // HubSidebar always opens both sections by default; the user can collapse
  // them manually within a session.
  const [sortOpen, setSortOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);

  return (
    <aside
      aria-label="Hub filters"
      className="hidden w-[var(--flyout-width,280px)] shrink-0 flex-col gap-8 border-border/20 border-r bg-[var(--color-hub-card)] p-4 lg:flex"
    >
      <Collapsible onOpenChange={setSortOpen} open={sortOpen}>
        <SectionHeader label="Sort" />
        <CollapsibleContent
          aria-label="Sort templates by"
          className="flex flex-col gap-1 pt-1 pb-2"
          role="radiogroup"
        >
          {SORT_OPTIONS.map((opt) => {
            const active = opt.value === sortBy;
            return (
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio pattern on a <button> is the only option that supports rich label markup + click handling without form-association side effects (matches Radix RadioGroupItem).
              <button
                aria-checked={active}
                className={`flex items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none ${
                  active
                    ? "font-semibold text-[var(--color-text-accent)]"
                    : "font-normal text-muted-foreground hover:text-foreground"
                }`}
                key={opt.value}
                onClick={() => onSortChange(opt.value)}
                role="radio"
                tabIndex={active ? 0 : -1}
                type="button"
              >
                {opt.label}
              </button>
            );
          })}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible onOpenChange={setTagsOpen} open={tagsOpen}>
        <SectionHeader count={publicTags.length} label="Tags" />
        <CollapsibleContent className="flex flex-col gap-0.5 pt-1 pb-2">
          {publicTags.map((tag) => {
            const active = activeTagSlug === tag.slug;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none ${
                  active
                    ? "bg-[var(--color-hub-icon-bg)] font-semibold text-[var(--color-text-accent)]"
                    : "font-normal text-muted-foreground hover:bg-[var(--color-hub-icon-bg)] hover:text-foreground"
                }`}
                href={`/hub/tags/${tag.slug}`}
                key={tag.slug}
              >
                <span className="truncate">{tag.name}</span>
              </Link>
            );
          })}
        </CollapsibleContent>
      </Collapsible>
    </aside>
  );
}
