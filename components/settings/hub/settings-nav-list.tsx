"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isSettingsItemVisible, SETTINGS_NAV } from "./nav";
import { useSettingsContext } from "./settings-context";

const ROW =
  "flex h-9 items-center gap-3 rounded-md px-2 text-sm transition-colors";

export function SettingsNavList(): React.ReactElement {
  const pathname = usePathname();
  const { isAdmin, isOwner } = useSettingsContext();

  const groups = SETTINGS_NAV.map((group) => ({
    items: group.items.filter((item) =>
      isSettingsItemVisible(item, { isAdmin, isOwner })
    ),
    label: group.label,
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <Link
          className={cn(
            ROW,
            pathname === "/settings"
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        href="/settings"
      >
        All settings
      </Link>

      {groups.map((group) => (
        <div className="flex flex-col gap-0.5" key={group.label}>
          <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  ROW,
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
      ))}
    </>
  );
}
