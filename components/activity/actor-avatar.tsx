"use client";

import type { LucideIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type Actor = {
  id?: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  image?: string | null;
};

const WHITESPACE = /\s+/;

export function actorLabel(actor: Actor | null): string {
  return actor?.name || actor?.email || "System";
}

function initials(actor: Actor | null): string {
  const name = actor?.name?.trim();
  if (name) {
    const parts = name.split(WHITESPACE).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const second = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
    return (first + second).toUpperCase() || "?";
  }
  const email = actor?.email?.trim();
  return email ? email[0].toUpperCase() : "?";
}

export function ActorAvatar({
  actor,
  className,
}: {
  actor: Actor | null;
  className?: string;
}): React.ReactElement {
  return (
    <Avatar className={cn("size-7", className)}>
      {actor?.image ? (
        <AvatarImage alt={actorLabel(actor)} src={actor.image} />
      ) : null}
      <AvatarFallback className="text-[11px]">{initials(actor)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * Actor avatar with a small corner badge (e.g. an add/change/remove glyph).
 * The badge disc is painted with the page background so it cleanly punches out
 * of the avatar instead of letting it bleed through; `badgeClassName` adds the
 * colored tint + icon color on top of that opaque base.
 */
export function ActorAvatarBadge({
  actor,
  icon: Icon,
  badgeClassName,
}: {
  actor: Actor | null;
  icon: LucideIcon;
  badgeClassName?: string;
}): React.ReactElement {
  return (
    <div className="relative shrink-0">
      <ActorAvatar actor={actor} />
      <span
        className={cn(
          "-right-1 -bottom-1 absolute flex size-4 items-center justify-center rounded-full border border-border bg-card ring-2 ring-background",
          badgeClassName
        )}
      >
        <Icon className="size-2.5" />
      </span>
    </div>
  );
}
