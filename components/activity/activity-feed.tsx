"use client";

import { Minus, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "@/components/settings/session-format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { groupByDate } from "@/lib/activity/time-groups";
import { api, followPage, type SecurityAuditEvent } from "@/lib/api-client";
import {
  type AuditActionKind,
  describeAuditAction,
} from "@/lib/security/audit-actions";
import { ActorAvatar, actorLabel } from "./actor-avatar";

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
  change: "bg-amber-500/15 text-amber-500",
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

function ActivityRow({
  event,
}: {
  event: SecurityAuditEvent;
}): React.ReactElement {
  const { phrase, kind } = describeAuditAction(event.action);
  const Icon = KIND_ICON[kind];
  const meta = metadataLine(event);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${KIND_COLOR[kind]}`}
      >
        <Icon className="size-3" />
      </span>
      <ActorAvatar actor={event.actor} />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{actorLabel(event.actor)}</span>{" "}
          <span className="text-muted-foreground">{phrase}</span>
        </p>
        <p className="text-muted-foreground text-xs">
          {relativeTime(event.createdAt)}
          {meta ? ` · ${meta}` : ""}
        </p>
      </div>
    </li>
  );
}

export function ActivityFeed({
  params,
}: {
  params?: FeedParams;
}): React.ReactElement {
  const [events, setEvents] = useState<SecurityAuditEvent[]>([]);
  const [nextLink, setNextLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const resourceType = params?.resourceType;
  const resourceId = params?.resourceId;
  const action = params?.action;
  const limit = params?.limit;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    api.security
      .getAudit({ resourceType, resourceId, action, limit })
      .then((res) => {
        if (active) {
          setEvents(res.items);
          setNextLink(res._links.next);
        }
      })
      .catch(() => active && setError(true))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [resourceType, resourceId, action, limit]);

  const loadMore = useCallback(async () => {
    if (!nextLink) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await followPage<SecurityAuditEvent>(nextLink);
      setEvents((prev) => [...prev, ...res.items]);
      setNextLink(res._links.next);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextLink]);

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

  if (events.length === 0) {
    return (
      <p className="py-4 text-muted-foreground text-sm">
        No activity recorded yet.
      </p>
    );
  }

  const groups = groupByDate(events, (e) => e.createdAt);

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
      {nextLink && (
        <Button
          className="w-full"
          disabled={loadingMore}
          onClick={loadMore}
          size="sm"
          variant="ghost"
        >
          {loadingMore ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}
