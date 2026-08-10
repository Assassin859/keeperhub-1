"use client";

import Link from "next/link";
import { isSettingsItemVisible, SETTINGS_NAV, settingsAnchor } from "./nav";
import { useSettingsContext } from "./settings-context";

/**
 * The rail while searching: only sections that match stay, and each one lists
 * the settings inside it that matched, so the exact one is one click away.
 */
export function SettingsNavMatches({
  query,
}: {
  query: string;
}): React.ReactElement {
  const { isAdmin, isOwner } = useSettingsContext();
  const needle = query.trim().toLowerCase();

  const matches = SETTINGS_NAV.flatMap((group) => group.items)
    .filter((item) => isSettingsItemVisible(item, { isAdmin, isOwner }))
    .map((item) => ({
      entries: item.contents.filter((entry) =>
        entry.toLowerCase().includes(needle)
      ),
      item,
      labelHit: item.label.toLowerCase().includes(needle),
    }))
    .filter((match) => match.labelHit || match.entries.length > 0);

  if (matches.length === 0) {
    return (
      <p className="px-2 py-4 text-muted-foreground text-sm">
        No settings match that.
      </p>
    );
  }

  return (
    <>
      {matches.map(({ item, entries }) => (
        <div className="flex flex-col gap-0.5" key={item.href}>
          <Link
            className="flex h-9 items-center gap-3 rounded-md px-2 font-medium text-foreground text-sm transition-colors hover:bg-muted/60"
            data-testid={`settings-match-${item.href.split("/").pop()}`}
            href={item.href}
          >
            <item.icon className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
          {entries.map((entry) => (
            <Link
              className="flex h-8 items-center rounded-md pr-2 pl-9 text-muted-foreground text-sm transition-colors hover:bg-muted/60 hover:text-foreground"
              href={`${item.href}?highlight=${settingsAnchor(entry)}`}
              key={entry}
            >
              <span className="truncate">{entry}</span>
            </Link>
          ))}
        </div>
      ))}
    </>
  );
}
