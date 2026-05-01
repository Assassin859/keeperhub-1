"use client";

import { BookOpen, Play } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";

const HERO_SUB =
  "Browse protocols, fork community workflows, and discover paid services on the marketplace.";

type HubHeroProps = {
  /**
   * @deprecated Phase 44 moved the search input into the tab-strip band
   * (`components/hub/hub-tab-search.tsx`, wired in plan 44-09). This prop
   * is preserved only for backwards-compatible imports during the migration
   * window. The hero no longer renders a search input.
   */
  searchQuery?: string;
  /** @deprecated See searchQuery — unused in Phase 44. */
  onSearchChange?: (query: string) => void;
};

function trimmedName(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function HubHero(_props: HubHeroProps = {}): React.ReactElement {
  const { data: session, isPending } = useSession();
  // Show the bare headline on first paint and for anonymous / signed-out
  // users. Signed-in users get their full name appended.
  const showName =
    !isPending && session?.user && !isAnonymousUser(session.user);
  const name = showName ? trimmedName(session?.user?.name) : null;
  const headline = name
    ? `Welcome to KeeperHub ${name}!`
    : "Welcome to KeeperHub!";

  return (
    <div className="pb-6">
      <div className="flex items-end justify-between gap-8">
        <div>
          <h1 className="font-semibold text-xl tracking-tight">{headline}</h1>
          <p className="mt-1 text-muted-foreground text-sm">{HERO_SUB}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pb-0.5">
          <a
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-hub-icon-bg)] px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-border/60 hover:text-foreground motion-reduce:transition-none"
            href="https://youtube.com/@KeeperHub"
            rel="noopener noreferrer"
            target="_blank"
          >
            <Play className="size-3" />
            Demos
          </a>
          <a
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-hub-icon-bg)] px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-border/60 hover:text-foreground motion-reduce:transition-none"
            href="https://docs.keeperhub.com"
            rel="noopener noreferrer"
            target="_blank"
          >
            <BookOpen className="size-3" />
            Docs
          </a>
        </div>
      </div>
    </div>
  );
}
