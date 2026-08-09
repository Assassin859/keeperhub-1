"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  isSettingsItemVisible,
  matchesSettingsQuery,
  SETTINGS_NAV,
} from "./nav";
import { OverviewCard } from "./overview-card";
import { EmptyState, SectionHeader } from "./section";
import { useSettingsContext } from "./settings-context";

export function OverviewSection(): React.ReactElement {
  const { isOwner, isAdmin, organizationName } = useSettingsContext();
  const [query, setQuery] = useState("");

  const groups = SETTINGS_NAV.map((group) => ({
    items: group.items.filter(
      (item) =>
        isSettingsItemVisible(item, { isAdmin, isOwner }) &&
        matchesSettingsQuery(item, query)
    ),
    label: group.label,
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <SectionHeader
        action={
          <div className="relative w-64">
            <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              data-testid="settings-search"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              value={query}
            />
          </div>
        }
        description={`Everything you can change${organizationName ? ` in ${organizationName}` : ""} and in your own account. Search by feature if you are not sure which section owns it.`}
        title="Settings"
      />

      {groups.length === 0 && (
        <EmptyState>
          Nothing matches that. Try a feature name like "withdraw", "invite" or
          "scopes".
        </EmptyState>
      )}

      {groups.map((group) => (
        <section className="flex flex-col gap-3" key={group.label}>
          <h2 className="font-medium font-mono text-[0.625rem] text-muted-foreground uppercase tracking-widest">
            {group.label}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.items.map((item) => (
              <OverviewCard item={item} key={item.href} query={query} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
