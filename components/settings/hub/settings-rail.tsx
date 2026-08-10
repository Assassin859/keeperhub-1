"use client";

import { ArrowLeft, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useExitPath } from "./hooks/use-exit-path";
import { useRailWidth } from "./hooks/use-rail-width";
import { SettingsNavList } from "./settings-nav-list";
import { SettingsNavMatches } from "./settings-nav-matches";
import { SettingsSearch } from "./settings-search";

export function SettingsRail(): React.ReactElement {
  const [query, setQuery] = useState("");
  const exitPath = useExitPath();
  const rail = useRailWidth();
  const searching = query.trim().length > 0;

  const expand = (): void => {
    if (!rail.expanded) {
      rail.toggle();
    }
  };

  return (
    <aside
      aria-label="Settings navigation"
      className={cn(
        "relative flex shrink-0 flex-col border-r bg-background",
        !rail.dragging && "transition-[width] duration-200 ease-out"
      )}
      data-expanded={rail.expanded}
      data-testid="settings-rail"
      style={{ width: rail.width }}
    >
      <div className="flex shrink-0 items-center border-b px-2.5 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Leave settings"
              asChild
              className={cn("h-8 gap-2 px-2", !rail.expanded && "w-full px-0")}
              size="sm"
              variant="ghost"
            >
              <Link href={exitPath}>
                <ArrowLeft className="size-4 shrink-0" />
                {rail.expanded && <span className="truncate">Back</span>}
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Back to {exitPath}</TooltipContent>
        </Tooltip>
      </div>

      {rail.expanded ? (
        <SettingsSearch onQueryChange={setQuery} query={query} />
      ) : (
        // Collapsed there is nowhere to type, so searching reopens the rail.
        <div className="flex justify-center px-2 pt-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Search settings"
                className="size-8"
                onClick={expand}
                size="icon"
                variant="ghost"
              >
                <Search className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Search settings</TooltipContent>
          </Tooltip>
        </div>
      )}

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-2 pb-4">
        {searching ? (
          <SettingsNavMatches query={query} />
        ) : (
          <SettingsNavList expanded={rail.expanded} />
        )}
      </nav>

      <div className="flex shrink-0 justify-end border-t p-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={rail.expanded ? "Collapse sidebar" : "Expand sidebar"}
              className="size-8"
              onClick={rail.toggle}
              size="icon"
              variant="ghost"
            >
              {rail.expanded ? (
                <PanelLeftClose className="size-4" />
              ) : (
                <PanelLeftOpen className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {rail.expanded ? "Collapse" : "Expand"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Drag the edge to resize; it snaps to collapsed or expanded on release. */}
      {/* biome-ignore lint/a11y/useSemanticElements: resize handle, mirrors the workflow sidebar */}
      <div
        aria-label="Resize settings sidebar"
        aria-orientation="vertical"
        aria-valuenow={rail.width}
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize"
        onMouseDown={rail.onResizeStart}
        role="separator"
        tabIndex={0}
      />
    </aside>
  );
}
