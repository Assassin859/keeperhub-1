"use client";

import { Minus, Pencil, Plus } from "lucide-react";
import { relativeTime } from "@/components/settings/session-format";
import { Skeleton } from "@/components/ui/skeleton";
import { groupByDate } from "@/lib/activity/time-groups";
import { api, type SecurityAuditEvent } from "@/lib/api-client";
import { usePaginatedResource } from "@/lib/hooks/use-paginated-resource";
import type { PageMeta } from "@/lib/pagination";
import {
  type AuditActionKind,
  describeAuditAction,
} from "@/lib/security/audit-actions";
import { ActorAvatar, actorLabel } from "./actor-avatar";
import { Pager } from "./pager";

type FeedParams = {
  resourceType?: string;
  resourceId?: string;
  action?: string;
  limit?: number;
};

const KIND_ICON: Record<AuditActionKind, typeof Plus> = {
  add: Plus,
  remove: Minus,
  change: Pencil,
};

const KIND_COLOR: Record<AuditActionKind, string> = {
  add: "bg-keeperhub-green/15 text-keeperhub-green",
  remove: "bg-destructive/15 text-destructive",
  change: "bg-amber-400/15 text-amber-400",
};

function metadataLine(event: SecurityAuditEvent): string | null {
  const meta = event.metadata as Record<string, unknown> | null;
  if (!meta) {
    return null;
  }
  const parts: string[] = [];
  if (typeof meta.ip === "string") {
    parts.push(meta.ip);
  }
  if (typeof meta.country === "string") {
    parts.push(meta.country);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function roleLabel(role?: string | null): string | null {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : null;
}

type DiffEntry = { label: string; from: string | null; to: string | null };

// Mask values whose field name looks like a secret, even though the audit
// layer already curates before/after (keys store only name + keyPrefix). This
// is a display-side backstop so a future careless audit call can't leak a
// token through the feed. `keyPrefix` is intentionally not matched -- it is a
// prefix by design, not the secret.
const SENSITIVE_FIELD =
  /(?:^|[_.])(?:token|secret|password|privatekey|private_key|mnemonic|seed|hash|apikey)(?:[_.]|$)|^key$/i;

// Opaque machine values that read as noise in a human feed (e.g. a definition
// content hash). The change is still recorded; we just don't print the value.
const HIDDEN_FIELDS = new Set(["contentHash"]);

function humanizeField(path: Array<string | number>): string {
  const key = String(path.at(-1) ?? "");
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Value";
}

function formatValue(value: unknown, sensitive: boolean): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (sensitive) {
    return "•••";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "[changed]";
}

// Turn the stored deep-diff array into readable "Field: old -> new" rows.
function diffEntries(diff: unknown): DiffEntry[] {
  if (!Array.isArray(diff)) {
    return [];
  }
  const entries: DiffEntry[] = [];
  for (const change of diff) {
    if (!change || typeof change !== "object") {
      continue;
    }
    const c = change as {
      kind?: string;
      path?: Array<string | number>;
      lhs?: unknown;
      rhs?: unknown;
    };
    const path = c.path ?? [];
    const fieldKey = String(path.at(-1) ?? "");
    if (HIDDEN_FIELDS.has(fieldKey)) {
      continue;
    }
    const sensitive = SENSITIVE_FIELD.test(fieldKey);
    const label = humanizeField(path);
    if (c.kind === "E") {
      entries.push({
        label,
        from: formatValue(c.lhs, sensitive),
        to: formatValue(c.rhs, sensitive),
      });
    } else if (c.kind === "N") {
      entries.push({ label, from: null, to: formatValue(c.rhs, sensitive) });
    } else if (c.kind === "D") {
      entries.push({ label, from: formatValue(c.lhs, sensitive), to: null });
    }
  }
  return entries.filter((e) => e.from !== null || e.to !== null).slice(0, 6);
}

function DiffLines({ diff }: { diff: unknown }): React.ReactElement | null {
  const entries = diffEntries(diff);
  if (entries.length === 0) {
    return null;
  }
  return (
    <ul className="mt-1 space-y-0.5">
      {entries.map((entry) => (
        <li
          className="text-muted-foreground text-xs"
          key={`${entry.label}:${entry.from ?? ""}:${entry.to ?? ""}`}
        >
          <span className="font-medium text-foreground/70">{entry.label}:</span>{" "}
          {entry.from !== null && (
            <span className="opacity-60">{entry.from}</span>
          )}
          {entry.from !== null && entry.to !== null && " → "}
          {entry.to !== null && <span>{entry.to}</span>}
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({
  event,
}: {
  event: SecurityAuditEvent;
}): React.ReactElement {
  const { phrase, kind } = describeAuditAction(event.action);
  const Icon = KIND_ICON[kind];
  const meta = metadataLine(event);
  const actor = event.actor;
  const role = roleLabel(actor?.role);
  // Show the email on its own line only when we also have a name -- otherwise
  // actorLabel already falls back to the email.
  const email = actor?.name ? actor.email : null;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="relative shrink-0">
        <ActorAvatar actor={actor} />
        <span
          className={`-right-1 -bottom-1 absolute flex size-4 items-center justify-center rounded-full ring-2 ring-background ${KIND_COLOR[kind]}`}
        >
          <Icon className="size-2.5" />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">
          <span className="font-medium">{actorLabel(actor)}</span>
          {role && (
            <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 align-middle font-medium text-[10px] text-muted-foreground uppercase">
              {role}
            </span>
          )}{" "}
          <span className="text-muted-foreground">{phrase}</span>
        </p>
        <DiffLines diff={event.diff} />
        {email && (
          <p className="truncate text-muted-foreground text-xs">{email}</p>
        )}
        <p className="text-muted-foreground text-xs">
          {relativeTime(event.createdAt)}
          {meta ? ` · ${meta}` : ""}
        </p>
      </div>
    </li>
  );
}

// Merge synthesized baseline entries (e.g. a key's creation when no audit
// event was ever recorded) with the real feed. Baselines belong on the first
// (newest) page only and are dropped for any resource that already has a real
// "created" event.
function mergeFallback(
  events: SecurityAuditEvent[],
  fallback: SecurityAuditEvent[] | undefined,
  meta: PageMeta | null
): SecurityAuditEvent[] {
  if (!fallback?.length || (meta && meta.page > 1)) {
    return events;
  }
  const covered = new Set(
    events
      .filter((e) => e.action.endsWith(".created") && e.resourceId)
      .map((e) => e.resourceId)
  );
  const extra = fallback.filter(
    (f) => !(f.resourceId && covered.has(f.resourceId))
  );
  return [...events, ...extra].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1
  );
}

export function ActivityFeed({
  params,
  fallback,
}: {
  params?: FeedParams;
  fallback?: SecurityAuditEvent[];
}): React.ReactElement {
  const resourceType = params?.resourceType;
  const resourceId = params?.resourceId;
  const action = params?.action;
  const limit = params?.limit;

  const {
    items: events,
    meta,
    setPage,
    loading,
    error,
  } = usePaginatedResource<SecurityAuditEvent>(
    (page) =>
      api.security.getAudit({ resourceType, resourceId, action, page, limit }),
    JSON.stringify({ resourceType, resourceId, action, limit })
  );

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div className="flex items-center gap-3" key={i}>
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="py-4 text-muted-foreground text-sm">
        Failed to load activity.
      </p>
    );
  }

  const merged = mergeFallback(events, fallback, meta);

  if (merged.length === 0) {
    return (
      <p className="py-4 text-muted-foreground text-sm">
        No activity recorded yet.
      </p>
    );
  }

  const groups = groupByDate(merged, (e) => e.createdAt);

  return (
    <div className="thin-scrollbar space-y-4 overflow-y-auto">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="sticky top-0 bg-background py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {group.label}
          </p>
          <ul className="divide-y divide-border/60">
            {group.items.map((event) => (
              <ActivityRow event={event} key={event.id} />
            ))}
          </ul>
        </div>
      ))}
      {meta && (
        <div className="pt-1">
          <Pager meta={meta} onPage={setPage} unit="events" />
        </div>
      )}
    </div>
  );
}
