"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isSettingsItemVisible, SETTINGS_NAV } from "./nav";
import { useSettingsContext } from "./settings-context";

// Matches EXPANDED_WIDTH in the workflow sidebar so the two rails line up.
export const SETTINGS_RAIL_WIDTH = 200;

export function SettingsRail(): React.ReactElement {
  const pathname = usePathname();
  const { isAdmin, isOwner } = useSettingsContext();

  return (
    <aside
      aria-label="Settings navigation"
      className="flex shrink-0 flex-col border-r bg-background"
      data-testid="settings-rail"
      style={{ width: SETTINGS_RAIL_WIDTH }}
    >
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pt-3 pb-4">
        <Link
          className={cn(
            "flex h-9 items-center rounded-md px-2 text-sm transition-colors",
            pathname === "/settings"
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
          href="/settings"
        >
          All settings
        </Link>

        {SETTINGS_NAV.map((group) => {
          const items = group.items.filter((item) =>
            isSettingsItemVisible(item, { isAdmin, isOwner })
          );
          if (items.length === 0) {
            return null;
          }
          return (
            <div className="flex flex-col gap-0.5" key={group.label}>
              <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                {group.label}
              </p>
              {items.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-9 items-center gap-3 rounded-md px-2 text-sm transition-colors",
                      active
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                    data-testid={`settings-nav-${item.href.split("/").pop()}`}
                    href={item.href}
                    key={item.href}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
