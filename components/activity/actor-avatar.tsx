"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type Actor = {
  id?: string;
  name?: string | null;
  email?: string | null;
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
