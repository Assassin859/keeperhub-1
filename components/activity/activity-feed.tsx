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
import { ActorAvatarBadge, actorLabel } from "./actor-avatar";
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
  add: "text-keeperhub-green",
  remove: "text-destructive",
  change: "text-amber-400",
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
    // Root-level changes (no field path) are whole-object create/delete diffs;
    // the action phrase ("created a project") already says it, so skip them
    // rather than printing "Value: [changed]".
    if (path.length === 0) {
      continue;
    }
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

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

function ValuePiece({ value }: { value: string }): React.ReactElement {
  if (HEX_COLOR.test(value)) {
    return (
      <span
        className="inline-block size-3 rounded-full border border-border align-middle"
        style={{ backgroundColor: value }}
        title={value}
      />
    );
  }
  return <>{value}</>;
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
            <span className="opacity-60">
              <ValuePiece value={entry.from} />
            </span>
          )}
          {entry.from !== null && entry.to !== null && " → "}
          {entry.to !== null && (
            <span>
              <ValuePiece value={entry.to} />
            </span>
          )}
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
      <ActorAvatarBadge
        actor={actor}
        badgeClassName={KIND_COLOR[kind]}
        icon={Icon}
      />
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

// Stable keys for the placeholder rows so the skeleton list doesn't key on
// the array index.
const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

function SkeletonRow(): React.ReactElement {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Skeleton className="size-7 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2 py-0.5">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </li>
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

  // Only blank to skeletons on the very first load. Page changes and silent
  // refetches keep the current rows mounted (the hook retains `events` until
  // the next page resolves), so the modal height stays put instead of
  // collapsing and re-expanding on every navigation.
  if (loading && events.length === 0 && !error) {
    return (
      <ul className="divide-y divide-border/60">
        {SKELETON_KEYS.slice(0, Math.min(limit ?? 3, SKELETON_KEYS.length)).map(
          (key) => (
            <SkeletonRow key={key} />
          )
        )}
      </ul>
    );
  }

  if (error && events.length === 0) {
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
  // When the feed spans multiple pages, hold a floor height so paging onto a
  // shorter last page doesn't resize the modal.
  const paged = Boolean(meta && meta.totalPages > 1);

  return (
    <div
      className={`thin-scrollbar space-y-4 overflow-y-auto ${paged ? "min-h-80" : ""}`}
    >
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
