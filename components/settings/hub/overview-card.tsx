"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { SettingsNavItem } from "./nav";

/** Highlights the matched span so it is obvious why a card survived a search. */
function Highlight({
  text,
  query,
}: {
  text: string;
  query: string;
}): React.ReactNode {
  const needle = query.trim().toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-foreground/15 text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export function OverviewCard({
  item,
  query,
}: {
  item: SettingsNavItem;
  query: string;
}): React.ReactElement {
  return (
    <Link
      className="group flex flex-col gap-3 rounded-xl border bg-card/60 p-4 transition-colors hover:bg-muted/40"
      href={item.href}
    >
      <span className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <item.icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-1.5 font-semibold text-sm">
            <Highlight query={query} text={item.label} />
            <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
          <span className="text-muted-foreground text-xs">
            {item.description}
          </span>
        </span>
      </span>

      <span className="flex flex-wrap gap-1.5">
        {item.contents.map((entry) => (
          <span
            className="rounded-md border px-2 py-0.5 text-[0.6875rem]"
            key={entry}
          >
            <Highlight query={query} text={entry} />
          </span>
        ))}
      </span>
    </Link>
  );
}
