"use client";

import { Search, X } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { SettingsNavList } from "./settings-nav-list";

// Matches EXPANDED_WIDTH in the workflow sidebar so the two rails line up.
export const SETTINGS_RAIL_WIDTH = 200;

export function SettingsRail(): React.ReactElement {
  const [query, setQuery] = useState("");

  return (
    <aside
      aria-label="Settings navigation"
      className="flex shrink-0 flex-col border-r bg-background"
      data-testid="settings-rail"
      style={{ width: SETTINGS_RAIL_WIDTH }}
    >
      {/* Search sits above the nav so a setting can be found by name without
          leaving whichever section is open. */}
      <div className="relative px-2.5 pt-3">
        <Search className="-translate-y-1/2 absolute top-[calc(50%+6px)] left-4.5 size-3.5 text-muted-foreground" />
        <Input
          className="h-8 pr-7 pl-8 text-sm"
          data-testid="settings-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="Search settings"
          value={query}
        />
        {query && (
          <button
            aria-label="Clear search"
            className="-translate-y-1/2 absolute top-[calc(50%+6px)] right-4 text-muted-foreground hover:text-foreground"
            onClick={() => setQuery("")}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-2 pb-4">
        <SettingsNavList query={query} />
      </nav>
    </aside>
  );
}
