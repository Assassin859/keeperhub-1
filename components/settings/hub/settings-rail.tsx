"use client";

import { SettingsNavList } from "./settings-nav-list";
import { SettingsSearch } from "./settings-search";

// Matches EXPANDED_WIDTH in the workflow sidebar so the two rails line up.
export const SETTINGS_RAIL_WIDTH = 200;

export function SettingsRail(): React.ReactElement {
  return (
    <aside
      aria-label="Settings navigation"
      className="flex shrink-0 flex-col border-r bg-background"
      data-testid="settings-rail"
      style={{ width: SETTINGS_RAIL_WIDTH }}
    >
      <SettingsSearch />

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-2 pb-4">
        <SettingsNavList />
      </nav>
    </aside>
  );
}
