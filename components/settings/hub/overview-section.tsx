"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { SETTINGS_NAV, isSettingsItemVisible } from "./nav";
import { SectionHeader } from "./section";
import { useSettingsContext } from "./settings-context";

export function OverviewSection(): React.ReactElement {
  const { isOwner, isAdmin, organizationName } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description={`Everything that used to hide in the avatar menu, the org switcher and the wallet modal, in one place${organizationName ? ` for ${organizationName}` : ""}.`}
        title="Settings"
      />

      {SETTINGS_NAV.map((group) => {
        const items = group.items.filter((item) =>
          isSettingsItemVisible(item, { isAdmin, isOwner })
        );
        if (items.length === 0) {
          return null;
        }
        return (
          <section className="flex flex-col gap-3" key={group.label}>
            <h2 className="font-medium font-mono text-[0.625rem] text-muted-foreground uppercase tracking-widest">
              {group.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((item) => (
                <Link
                  className="group flex items-start gap-3 rounded-xl border bg-card/60 p-4 transition-colors hover:bg-muted/40"
                  href={item.href}
                  key={item.href}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                    <item.icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-1.5 font-semibold text-sm">
                      {item.label}
                      <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {item.description}
                    </span>
                    {item.movedFrom && (
                      <span className="font-mono text-[0.625rem] text-muted-foreground/70">
                        was: {item.movedFrom}
                      </span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
