"use client";

import { Minus, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { SENSITIVE_FIELD } from "@/lib/security/audit-redaction";
import { ActorAvatarBadge, actorLabel } from "./actor-avatar";
import { Pager } from "./pager";

type FeedParams = {
  resourceType?: string;
  resourceTypes?: string[];
  resourceId?: string;
  resourceIds?: string[];
  projectIds?: string[];
  tagIds?: string[];
  workflowIds?: string[];
  action?: string;
  actorUserId?: string;
  actorUserIds?: string[];
  from?: string;
  to?: string;
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function roleLabel(role?: string | null): string | null {
  return role ? capitalize(role) : null;
}

type DiffEntry = { label: string; from: string | null; to: string | null };

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
        <div className="flex items-baseline justify-between gap-2 text-sm leading-snug">
          <span className="min-w-0 truncate">
            <span className="font-medium">{actorLabel(actor)}</span>
            {role && (
              <span className="ml-1 text-muted-foreground text-xs">
                · {role}
              </span>
            )}
          </span>
          <span className="shrink-0 whitespace-nowrap text-muted-foreground">
            {capitalize(phrase)}
          </span>
        </div>
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

// Synthesized baseline entries stand in for a resource's creation when no
// audit event was ever recorded (it pre-dates auditing). A creation is the
// OLDEST event for its resource, so it belongs on the last/oldest page -- never
// page 1, where appending it would overflow the page size and show the
// "creation" out of order. On the last page we drop any fallback whose resource
// already has a real ".created" event there, then merge the rest in date order.
function mergeFallback(
  events: SecurityAuditEvent[],
  fallback: SecurityAuditEvent[] | undefined,
  meta: PageMeta | null
): SecurityAuditEvent[] {
  if (!fallback?.length) {
    return events;
  }
  const onLastPage = !meta || meta.page >= meta.totalPages;
  if (!onLastPage) {
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
  if (extra.length === 0) {
    return events;
  }
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
  embedded = false,
}: {
  params?: FeedParams;
  fallback?: SecurityAuditEvent[];
  /**
   * When the feed lives inside an already-scrolling container (e.g. the
   * Settings overlay), set this to skip the feed's own fixed-height scroll box
   * and avoid a nested second scrollbar; the parent owns scrolling.
   */
  embedded?: boolean;
}): React.ReactElement {
  const resourceType = params?.resourceType;
  const resourceTypes = params?.resourceTypes;
  const resourceId = params?.resourceId;
  const resourceIds = params?.resourceIds;
  const projectIds = params?.projectIds;
  const tagIds = params?.tagIds;
  const workflowIds = params?.workflowIds;
  const action = params?.action;
  const actorUserId = params?.actorUserId;
  const actorUserIds = params?.actorUserIds;
  const from = params?.from;
  const to = params?.to;
  const limit = params?.limit;

  const {
    items: events,
    meta,
    setPage,
    loading,
    error,
  } = usePaginatedResource<SecurityAuditEvent>(
    (page) =>
      api.security.getAudit({
        resourceType,
        resourceTypes,
        resourceId,
        resourceIds,
        projectIds,
        tagIds,
        workflowIds,
        action,
        actorUserId,
        actorUserIds,
        from,
        to,
        page,
        limit,
      }),
    JSON.stringify({
      resourceType,
      resourceTypes,
      resourceId,
      resourceIds,
      projectIds,
      tagIds,
      workflowIds,
      action,
      actorUserId,
      actorUserIds,
      from,
      to,
      limit,
    })
  );

  // Capture the settled content height so the skeleton can hold it on the next
  // load. Without this the embedded feed (no fixed box) collapses to the
  // skeleton's natural height and back, jumping the modal on every filter/page
  // change. Per-resource overlays use the fixed box below instead.
  const listRef = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState<number>();
  useEffect(() => {
    if (embedded && !loading && listRef.current) {
      setReservedHeight(listRef.current.offsetHeight);
    }
  }, [embedded, loading]);

  // Fixed-height scroll region (when a page size is set) so the modal never
  // resizes: the skeleton, every page, and the empty/error states all occupy
  // the same box, and content taller than the box scrolls inside it instead of
  // growing the modal. The Pager lives outside this box so it stays put.
  const scrollClass = embedded
    ? ""
    : `thin-scrollbar overflow-y-auto ${limit ? "h-[32rem]" : ""}`;

  // Skeletons show on every load in both modes. In the fixed box the swap is
  // absorbed; when embedded, the skeleton holds the last content height
  // (reservedHeight) so the modal doesn't jump.
  if (loading) {
    return (
      <div>
        <div
          className={scrollClass}
          style={embedded ? { minHeight: reservedHeight } : undefined}
        >
          <ul className="divide-y divide-border/60">
            {SKELETON_KEYS.slice(
              0,
              Math.min(limit ?? 3, SKELETON_KEYS.length)
            ).map((key) => (
              <SkeletonRow key={key} />
            ))}
          </ul>
        </div>
        {meta && (
          <div className="pt-2">
            <Pager meta={meta} onPage={setPage} unit="events" />
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className={scrollClass}>
        <p className="py-4 text-muted-foreground text-sm">
          Failed to load activity.
        </p>
      </div>
    );
  }

  const merged = mergeFallback(events, fallback, meta);

  if (merged.length === 0) {
    return (
      <div className={scrollClass}>
        <p className="py-4 text-muted-foreground text-sm">
          No activity recorded yet.
        </p>
      </div>
    );
  }

  const groups = groupByDate(merged, (e) => e.createdAt);

  return (
    <div>
      <div className={`${scrollClass} space-y-4`} ref={listRef}>
        {groups.map((group) => (
          <div key={group.label}>
            <p className="sticky top-0 z-10 bg-background py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.label}
            </p>
            <ul className="divide-y divide-border/60">
              {group.items.map((event) => (
                <ActivityRow event={event} key={event.id} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {meta && (
        <div className="pt-2">
          <Pager meta={meta} onPage={setPage} unit="events" />
        </div>
      )}
    </div>
  );
}
