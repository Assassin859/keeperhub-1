"use client";

import { CornerDownLeft, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { searchSettings, settingsAnchor } from "./nav";
import { useSettingsContext } from "./settings-context";

/**
 * Finds an individual setting rather than a section: results name the setting
 * ("Password") under its section ("Security"), and selecting one opens that
 * section with the matching card highlighted.
 */
export function SettingsSearch(): React.ReactElement {
  const router = useRouter();
  const { isAdmin, isOwner } = useSettingsContext();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const hits = searchSettings(query, { isAdmin, isOwner });
  const open = query.trim().length > 0;

  const go = (index: number): void => {
    const hit = hits[index];
    if (!hit) {
      return;
    }
    setQuery("");
    setCursor(0);
    router.push(`${hit.item.href}?highlight=${settingsAnchor(hit.entry)}`);
  };

  return (
    <div className="relative px-2.5 pt-3">
      <Search className="-translate-y-1/2 absolute top-[calc(50%+6px)] left-4.5 size-3.5 text-muted-foreground" />
      <Input
        className="h-8 pr-7 pl-8 text-sm"
        data-testid="settings-search"
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, hits.length - 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          }
          if (e.key === "Enter") {
            e.preventDefault();
            go(cursor);
          }
        }}
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

      {open && (
        <div
          className="absolute inset-x-2.5 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md"
          data-testid="settings-search-results"
        >
          {hits.length === 0 ? (
            <p className="px-3 py-2.5 text-muted-foreground text-sm">
              No settings match that.
            </p>
          ) : (
            hits.map((hit, index) => (
              <button
                className={cn(
                  "flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors",
                  index === cursor ? "bg-muted" : "hover:bg-muted/60"
                )}
                key={`${hit.item.href}-${hit.entry}`}
                onClick={() => go(index)}
                onMouseEnter={() => setCursor(index)}
                type="button"
              >
                <hit.item.icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">{hit.entry}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {hit.item.label}
                  </span>
                </span>
                {index === cursor && (
                  <CornerDownLeft className="ml-auto size-3 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
