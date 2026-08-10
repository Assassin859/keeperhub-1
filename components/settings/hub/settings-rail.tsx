"use client";

import { useState } from "react";
import { SettingsNavList } from "./settings-nav-list";
import { SettingsNavMatches } from "./settings-nav-matches";
import { SettingsSearch } from "./settings-search";

// Matches EXPANDED_WIDTH in the workflow sidebar so the two rails line up.
export const SETTINGS_RAIL_WIDTH = 200;

export function SettingsRail(): React.ReactElement {
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  return (
    <aside
      aria-label="Settings navigation"
      className="flex shrink-0 flex-col border-r bg-background"
      data-testid="settings-rail"
      style={{ width: SETTINGS_RAIL_WIDTH }}
    >
      <SettingsSearch onQueryChange={setQuery} query={query} />

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-2 pb-4">
        {searching ? <SettingsNavMatches query={query} /> : <SettingsNavList />}
      </nav>
    </aside>
  );
}
