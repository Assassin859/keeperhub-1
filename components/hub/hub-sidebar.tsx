"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { PublicTag } from "@/lib/api-client";

export type SortValue = "most-used" | "featured" | "top-rated" | "name";

type HubSidebarProps = {
  publicTags: PublicTag[];
  sortBy: SortValue;
  onSortChange: (next: SortValue) => void;
};

const SORT_OPTIONS: ReadonlyArray<{ value: SortValue; label: string }> = [
  { value: "most-used", label: "Most used" },
  { value: "featured", label: "Featured" },
  { value: "top-rated", label: "Top rated" },
  { value: "name", label: "Name" },
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
        className="group flex w-full items-center justify-between rounded-md px-3 py-2 font-normal text-muted-foreground text-xs uppercase tracking-widest transition-colors duration-100 hover:bg-[var(--color-hub-icon-bg)]/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none"
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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // First-paint defaults are owned locally so the navigation-sidebar's
  // global panels.sort/panels.tags state (which both default to "closed"
  // for the nav sidebar UX) does not bleed through to the Hub sidebar.
  // HubSidebar always opens both sections by default; the user can collapse
  // them manually within a session.
  const [sortOpen, setSortOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);
  const tagsOverflow = publicTags.length > 12;

  return (
    <aside
      aria-label="Hub filters"
      className="hidden w-[240px] shrink-0 flex-col gap-8 rounded-r-xl bg-[var(--color-hub-card)] p-4 shadow-sm lg:flex"
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
        <CollapsibleContent
          className={`flex flex-col gap-0.5 pt-1 pb-2 ${
            tagsOverflow ? "max-h-96 overflow-y-auto" : ""
          }`}
        >
          {publicTags.map((tag) => {
            const active = activeTagSlug === tag.slug;
            const href = `/hub/tags/${tag.slug}`;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                aria-disabled={isPending}
                className={`flex min-h-7 items-center justify-between rounded-md py-1.5 text-sm transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none ${
                  active
                    ? "border-l-2 border-l-[var(--color-border-accent)] bg-[var(--color-hub-icon-bg)] pr-3 pl-2 font-semibold text-[var(--color-text-accent)]"
                    : "px-3 font-normal text-muted-foreground hover:bg-[var(--color-hub-icon-bg)] hover:text-foreground"
                } ${isPending ? "opacity-70" : ""}`}
                href={href}
                key={tag.slug}
                onClick={(e: React.MouseEvent<HTMLAnchorElement>): void => {
                  // Defer modifier-clicks (cmd/ctrl/shift/middle-click) to the
                  // browser so open-in-new-tab semantics are preserved.
                  if (
                    e.defaultPrevented ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey ||
                    e.button !== 0
                  ) {
                    return;
                  }
                  // Wrap the navigation in startTransition so React 19 keeps
                  // the old grid visible while /hub/tags/{slug} streams in.
                  // Without this, _view-shell.tsx re-mounts and the user sees
                  // a brief empty/loading flash between tag routes (UAT gap #4).
                  e.preventDefault();
                  startTransition((): void => {
                    router.push(href, { scroll: false });
                  });
                }}
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
