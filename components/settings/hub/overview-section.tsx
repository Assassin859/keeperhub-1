"use client";

import { isSettingsItemVisible, SETTINGS_NAV } from "./nav";
import { OverviewCard } from "./overview-card";
import { SectionHeader } from "./section";
import { useSettingsContext } from "./settings-context";

export function OverviewSection(): React.ReactElement {
  const { isOwner, isAdmin, organizationName } = useSettingsContext();

  const groups = SETTINGS_NAV.map((group) => ({
    items: group.items.filter((item) =>
      isSettingsItemVisible(item, { isAdmin, isOwner })
    ),
    label: group.label,
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <SectionHeader
        description={`Everything you can change${organizationName ? ` in ${organizationName}` : ""} and in your own account.`}
        title="Settings"
      />

      {groups.map((group) => (
        <section className="flex flex-col gap-3" key={group.label}>
          <h2 className="font-medium font-mono text-[0.625rem] text-muted-foreground uppercase tracking-widest">
            {group.label}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.items.map((item) => (
              <OverviewCard item={item} key={item.href} query="" />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
