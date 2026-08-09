"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-bold text-2xl tracking-tight">{title}</h1>
        {description && (
          <p className="max-w-xl text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): React.ReactElement {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-card/60 backdrop-blur-sm",
        className
      )}
    >
      {title && (
        <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold text-sm">{title}</h2>
            {description && (
              <p className="text-muted-foreground text-xs">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "accent" | "warning";
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border bg-card/60 p-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-bold text-xl tabular-nums">{value}</span>
      {hint && (
        <span
          className={cn(
            "text-xs",
            tone === "accent" && "text-foreground",
            tone === "warning" && "text-amber-400",
            tone === "neutral" && "text-muted-foreground"
          )}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: string }): React.ReactElement {
  return (
    <p className="py-6 text-center text-muted-foreground text-sm">{children}</p>
  );
}

/**
 * Row styling for every table in the settings hub.
 *
 * The divider sits on the row's own bottom edge, so the default full-height
 * hover fill would run straight into it. Instead the fill is drawn by an inset
 * pseudo-element on each cell -- 3px clear of the row box top and bottom -- so
 * it reads as a rounded band floating between the separators. `isolate` keeps
 * the `-z-10` fill behind the cell's own content.
 */
export const SETTINGS_ROW = [
  "border-border/60 hover:bg-transparent",
  "[&>td]:relative [&>td]:isolate [&>td]:py-3.5",
  "[&>td]:before:absolute [&>td]:before:inset-x-0 [&>td]:before:inset-y-[3px]",
  "[&>td]:before:-z-10 [&>td]:before:bg-transparent",
  "[&>td]:before:transition-colors [&>td]:before:content-['']",
  "[&:hover>td]:before:bg-muted/50",
  "[&>td:first-child]:before:rounded-l-lg [&>td:last-child]:before:rounded-r-lg",
].join(" ");

/** Header row: same horizontal rhythm as the body, a touch more air below. */
export const SETTINGS_HEAD_ROW = "border-border/60 [&>th]:h-9 [&>th]:pb-2";
