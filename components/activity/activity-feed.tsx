"use client";

import { ChevronRight, Minus, Pencil, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { IntegrationsOverlay } from "@/components/overlays/integrations-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
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

// The workflow definition (nodes/edges/config) is audited as a content hash;
// when it appears in the diff the build itself changed, even if no scalar field
// did. We don't print the hash (it's a HIDDEN_FIELD), so surface a plain note
// instead so the row says what kind of update happened.
function definitionChanged(diff: unknown): boolean {
  if (!Array.isArray(diff)) {
    return false;
  }
  return diff.some((c) => {
    const path = (c as { path?: Array<string | number> })?.path ?? [];
    return String(path.at(-1) ?? "") === "contentHash";
  });
}

// Resource types a feed row can open: workflows go to their editor's version
// History; integrations and API keys open their management modal. Types with no
// such destination (wallet signings, projects, tags) stay non-clickable.
const OPENABLE_TYPES = new Set([
  "workflow",
  "integration",
  "api_key",
  "org_api_key",
]);

function isOpenableEvent(event: SecurityAuditEvent): boolean {
  return (
    Boolean(event.resourceId) &&
    event.resourceType !== null &&
    OPENABLE_TYPES.has(event.resourceType)
  );
}

function ActivityRow({
  event,
  onOpen,
}: {
  event: SecurityAuditEvent;
  onOpen?: (event: SecurityAuditEvent) => void;
}): React.ReactElement {
  const { phrase, kind } = describeAuditAction(event.action);
  const Icon = KIND_ICON[kind];
  const meta = metadataLine(event);
  const actor = event.actor;
  const role = roleLabel(actor?.role);
  // Show the email on its own line only when we also have a name -- otherwise
  // actorLabel already falls back to the email.
  const email = actor?.name ? actor.email : null;
  const resourceName = event.resourceName;
  const canOpen = Boolean(onOpen) && isOpenableEvent(event);

  const header = (
    <>
      <div className="flex items-baseline justify-between gap-2 text-sm leading-snug">
        <span className="min-w-0 truncate">
          <span className="font-medium">{actorLabel(actor)}</span>
          {role && (
            <span className="ml-1 text-muted-foreground text-xs">· {role}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
          {capitalize(phrase)}
          {canOpen && <ChevronRight className="size-3.5" />}
        </span>
      </div>
      {resourceName && (
        <div className="mt-0.5 truncate font-medium text-foreground/90 text-sm">
          {resourceName}
        </div>
      )}
    </>
  );

  return (
    <li className="flex items-start gap-3 py-3">
      <ActorAvatarBadge
        actor={actor}
        badgeClassName={KIND_COLOR[kind]}
        icon={Icon}
      />
      <div className="min-w-0 flex-1">
        {canOpen ? (
          <button
            className="-mx-1 block w-full rounded px-1 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen?.(event)}
            type="button"
          >
            {header}
          </button>
        ) : (
          header
        )}
        <DiffLines diff={event.diff} />
        {definitionChanged(event.diff) && (
          <p className="mt-1 text-muted-foreground text-xs">
            Definition updated
          </p>
        )}
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
    <li className="flex items-start gap-3 py-3">
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
  fillHeight = false,
  syncPageToUrl = false,
  urlPageSizeDefault,
}: {
  params?: FeedParams;
  fallback?: SecurityAuditEvent[];
  /**
   * When the feed lives inside an already-scrolling container (e.g. the
   * Settings overlay), set this to skip the feed's own fixed-height scroll box
   * and avoid a nested second scrollbar; the parent owns scrolling.
   */
  embedded?: boolean;
  /**
   * Full-page mode: the feed grows to fill its flex parent and the pager is
   * pinned to the bottom of that space (the list scrolls between header and
   * pager). The parent must be a flex column with a bounded height.
   */
  fillHeight?: boolean;
  /**
   * Reflect the current page and page size in the URL (`?page=N&size=M`) and
   * seed them from it, so the feed is deep-linkable and survives refresh/back.
   * Page size is seeded by the caller (via params.limit); this only writes it
   * back. Only makes sense for a route-backed feed, not an overlay.
   */
  syncPageToUrl?: boolean;
  /**
   * The page size considered "default" when syncing to the URL: at this size
   * the `size` param is omitted to keep the URL clean. Defaults to the limit
   * being absent (always write when a limit is set).
   */
  urlPageSizeDefault?: number;
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

  // Open the event's resource: workflows leave for their editor's History tab
  // (deep-linked to the exact version when known); integrations and API keys
  // open their management modal on top of the feed.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialPage = syncPageToUrl
    ? Math.max(1, Number.parseInt(searchParams.get("page") ?? "", 10) || 1)
    : 1;
  const { closeAll, push } = useOverlay();
  const openResource = useCallback(
    (event: SecurityAuditEvent) => {
      if (!event.resourceId) {
        return;
      }
      if (event.resourceType === "workflow") {
        closeAll();
        const versionQuery =
          event.version === null ? "" : `&version=${event.version}`;
        router.push(
          `/workflows/${event.resourceId}?tab=history${versionQuery}`
        );
        return;
      }
      if (event.resourceType === "integration") {
        push(IntegrationsOverlay, { highlightId: event.resourceId });
        return;
      }
      if (
        event.resourceType === "api_key" ||
        event.resourceType === "org_api_key"
      ) {
        const highlightType: "api_key" | "org_api_key" = event.resourceType;
        push(ApiKeysOverlay, {
          highlightId: event.resourceId,
          highlightType,
        });
      }
    },
    [router, closeAll, push]
  );

  const {
    items: events,
    meta,
    page,
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
    }),
    { initialPage }
  );

  // Reflect the active page + size in the URL when asked (route-backed feed
  // only), dropping each param at its default (page 1 / default size) so the
  // URL stays clean. This is the single writer for both params, so size and
  // page changes never race each other. Reading searchParams here only to
  // preserve sibling params; it is intentionally not a dep -- our own replace
  // would otherwise loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see note above
  useEffect(() => {
    if (!syncPageToUrl) {
      return;
    }
    const next = new URLSearchParams(searchParams.toString());
    if (page > 1) {
      next.set("page", String(page));
    } else {
      next.delete("page");
    }
    if (limit && limit !== urlPageSizeDefault) {
      next.set("size", String(limit));
    } else {
      next.delete("size");
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [syncPageToUrl, page, limit, urlPageSizeDefault, pathname, router]);

  // Capture the settled content height so the skeleton can hold it on the next
  // load. Without this the embedded feed (no fixed box) collapses to the
  // skeleton's natural height and back, jumping the modal on every filter/page
  // change. Per-resource overlays use the fixed box below instead.
  const listRef = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState<number>();
  useEffect(() => {
    if (embedded && !fillHeight && !loading && listRef.current) {
      setReservedHeight(listRef.current.offsetHeight);
    }
  }, [embedded, fillHeight, loading]);

  // Three layout modes:
  // - fillHeight (full page): the list grows to fill the flex parent and scrolls
  //   internally, so the Pager stays pinned at the bottom of the viewport.
  // - embedded (already-scrolling overlay): no box, the parent owns scrolling.
  // - default (per-resource overlay): a fixed-height box so the modal never
  //   resizes; content taller than the box scrolls inside it.
  let scrollClass: string;
  if (fillHeight) {
    scrollClass = "thin-scrollbar min-h-0 flex-1 overflow-y-auto";
  } else if (embedded) {
    scrollClass = "";
  } else {
    scrollClass = `thin-scrollbar overflow-y-auto ${limit ? "h-[32rem]" : ""}`;
  }

  // In fillHeight mode the feed is a flex column so the list (flex-1) pushes the
  // Pager to the bottom; other modes keep the natural block flow.
  const rootClass = fillHeight ? "flex min-h-0 flex-1 flex-col" : undefined;
  const pagerClass = fillHeight ? "border-border/60 border-t pt-3" : "pt-2";

  // Skeletons show on every load in both modes. In the fixed box the swap is
  // absorbed; when embedded, the skeleton holds the last content height
  // (reservedHeight) so the modal doesn't jump.
  if (loading) {
    return (
      <div className={rootClass}>
        <div
          className={scrollClass}
          style={
            embedded && !fillHeight ? { minHeight: reservedHeight } : undefined
          }
        >
          <ul>
            {SKELETON_KEYS.slice(
              0,
              Math.min(limit ?? 3, SKELETON_KEYS.length)
            ).map((key) => (
              <SkeletonRow key={key} />
            ))}
          </ul>
        </div>
        {meta && (
          <div className={pagerClass}>
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
    <div className={rootClass}>
      <div className={scrollClass} ref={listRef}>
        {groups.map((group) => (
          <div key={group.label}>
            <p className="sticky top-0 z-10 mb-2 border-border/60 border-b bg-background pt-6 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide first:pt-0">
              {group.label}
            </p>
            <ul>
              {group.items.map((event) => (
                <ActivityRow
                  event={event}
                  key={event.id}
                  // A single-resource feed (e.g. a per-resource overlay) is
                  // already that resource's history, so its rows don't drill in.
                  onOpen={resourceId ? undefined : openResource}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {meta && (
        <div className={pagerClass}>
          <Pager meta={meta} onPage={setPage} unit="events" />
        </div>
      )}
    </div>
  );
}
