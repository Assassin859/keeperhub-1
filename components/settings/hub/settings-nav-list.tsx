"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  isSettingsItemActive,
  isSettingsItemVisible,
  SETTINGS_NAV,
  settingsHref,
} from "./nav";
import { useSettingsContext } from "./settings-context";

const ROW =
  "flex h-9 items-center gap-3 rounded-md px-2 text-sm transition-colors hover:bg-muted";

export function SettingsNavList({
  expanded = true,
}: {
  expanded?: boolean;
}): React.ReactElement {
  const pathname = usePathname();
  const { isAdmin, isOwner, organizationId } = useSettingsContext();

  const groups = SETTINGS_NAV.map((group) => ({
    items: group.items.filter((item) =>
      isSettingsItemVisible(item, { isAdmin, isOwner })
    ),
    label: group.label,
  })).filter((group) => group.items.length > 0);

  return (
    <>
      {groups.map((group) => (
        <div className="flex flex-col gap-0.5" key={group.label}>
          {expanded ? (
            <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
              {group.label}
            </p>
          ) : (
            // Collapsed rows have no labels, so a rule stands in for the
            // group heading and keeps the sections apart.
            <div className="mx-2 my-2 border-t" />
          )}
          {group.items.map((item) => {
            const active = isSettingsItemActive(item, pathname);
            const link = (
              <Link
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                className={cn(
                  ROW,
                  active && "bg-muted",
                  !expanded && "justify-center px-0"
                )}
                data-testid={`settings-nav-${item.segment}`}
                href={settingsHref(item, organizationId)}
                key={item.segment}
                // Sections are dynamic routes, so their code is not fetched
                // until asked for; prefetching keeps the click instant.
                prefetch
              >
                <item.icon className="size-4 shrink-0" />
                {expanded && <span className="truncate">{item.label}</span>}
              </Link>
            );

            // Collapsed the icon is all there is, so the name moves to a tooltip.
            if (expanded) {
              return link;
            }
            return (
              <Tooltip key={item.segment}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </>
  );
}
