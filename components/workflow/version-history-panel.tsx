"use client";

import { useAtom, useAtomValue } from "jotai";
import {
  ArrowRight,
  ChevronRight,
  Clock,
  Eye,
  GitBranch,
  Link2,
  Minus,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Unlink,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ActorAvatar, actorLabel } from "@/components/activity/actor-avatar";
import { Pager } from "@/components/activity/pager";
import { relativeTime } from "@/components/settings/session-format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type WorkflowVersionSummary } from "@/lib/api-client";
import { groupByDate } from "@/lib/activity/time-groups";
import { usePaginatedResource } from "@/lib/hooks/use-paginated-resource";
import {
  currentWorkflowIdAtom,
  previewVersionAtom,
  rightPanelWidthPctAtom,
  selectedNodeAtom,
  versionHistoryOpenAtom,
} from "@/lib/workflow/store";
import { useVersionPreview } from "@/lib/workflow/use-version-preview";
import type { VersionDiff } from "@/lib/workflow/version-diff";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

type ChangeKind =
  | "add"
  | "remove"
  | "change"
  | "connect"
  | "disconnect"
  | "enable"
  | "disable";

type ChangeItem = {
  key: string;
  kind: ChangeKind;
  content: ReactNode;
};

function Arrow(): React.ReactElement {
  return (
    <ArrowRight className="inline size-3 shrink-0 text-muted-foreground" />
  );
}

function Quoted({ value }: { value: string }): React.ReactElement {
  return <span className="font-medium">&quot;{value || "untitled"}&quot;</span>;
}

// Map a stored config key to the field label the user sees in the editor
// (e.g. "functionArgs" -> "Function Arguments"); fall back to the raw key.
function configFieldLabel(
  actionType: string | undefined,
  key: string
): string {
  // The action id itself is meta, not a form field; show it as "Action".
  if (key === "actionType") {
    return "Action";
  }
  if (!actionType) {
    return key;
  }
  const action = findActionById(actionType);
  if (!action) {
    return key;
  }
  const field = flattenConfigFields(action.configFields).find(
    (f) => f.key === key
  );
  return field?.label ?? key;
}

// A before/after value chip in a config diff: old values read as removed
// (red), new values as added (green); an absent value is a faint placeholder
// rather than a chip, so it never looks like a disabled control.
function DiffValue({
  value,
  tone,
}: {
  value: string;
  tone: "before" | "after";
}): React.ReactElement {
  if (!value || value === "empty") {
    return <span className="text-muted-foreground/60 italic">empty</span>;
  }
  const cls =
    tone === "before"
      ? "bg-destructive/10 text-destructive ring-1 ring-destructive/20"
      : "bg-keeperhub-green/10 text-keeperhub-green ring-1 ring-keeperhub-green/20";
  return (
    <span
      className={`break-all rounded px-1.5 py-0.5 font-mono leading-relaxed ${cls}`}
    >
      {value}
    </span>
  );
}

function settingItem(s: VersionDiff["settings"][number]): ChangeItem {
  if (s.field === "name") {
    return {
      key: "set-name",
      kind: "change",
      content: (
        <>
          Renamed workflow to <Quoted value={s.after} />
        </>
      ),
    };
  }
  if (s.field === "enabled") {
    const on = s.after === "true";
    return {
      key: "set-enabled",
      kind: on ? "enable" : "disable",
      content: on ? "Workflow enabled" : "Workflow disabled",
    };
  }
  if (s.field === "visibility") {
    return {
      key: "set-visibility",
      kind: "change",
      content: (
        <span className="inline-flex items-center gap-1">
          Visibility: {s.before} <Arrow /> {s.after}
        </span>
      ),
    };
  }
  return {
    key: "set-description",
    kind: "change",
    content: "Description updated",
  };
}

function nodeDeltaItem(
  n: VersionDiff["nodesChanged"][number],
  d: VersionDiff["nodesChanged"][number]["deltas"][number]
): ChangeItem {
  const key = `chg-${n.id}-${d.field}`;
  const who = <Quoted value={n.label} />;
  if (d.field === "name") {
    return {
      key,
      kind: "change",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Renamed <Quoted value={d.before ?? ""} /> <Arrow />{" "}
          <Quoted value={d.after ?? ""} />
        </span>
      ),
    };
  }
  if (d.field === "type") {
    return {
      key,
      kind: "change",
      content: (
        <span className="inline-flex items-center gap-1">
          {who} type: {d.before} <Arrow /> {d.after}
        </span>
      ),
    };
  }
  if (d.field === "configuration") {
    return {
      key,
      kind: "change",
      content: (
        <>
          {who} configuration changed
          {d.configKeys?.length ? ` (${d.configKeys.join(", ")})` : ""}
        </>
      ),
    };
  }
  if (d.field === "enabled") {
    const on = d.after === "true";
    return {
      key,
      kind: on ? "enable" : "disable",
      content: on ? <>Enabled {who}</> : <>Disabled {who}</>,
    };
  }
  return { key, kind: "change", content: <>{who} description updated</> };
}

function isVersionDiff(value: unknown): value is VersionDiff {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as VersionDiff).settings) &&
    Array.isArray((value as VersionDiff).nodesAdded)
  );
}

function buildChangeItems(diff: VersionDiff): ChangeItem[] {
  const items: ChangeItem[] = diff.settings.map(settingItem);
  for (const n of diff.nodesAdded) {
    items.push({
      key: `add-${n.id}`,
      kind: "add",
      content: (
        <>
          Added <Quoted value={n.label} />
        </>
      ),
    });
  }
  for (const n of diff.nodesRemoved) {
    items.push({
      key: `rem-${n.id}`,
      kind: "remove",
      content: (
        <>
          Removed <Quoted value={n.label} />
        </>
      ),
    });
  }
  for (const n of diff.nodesChanged) {
    for (const d of n.deltas) {
      // Expand a configuration change into one row per field, showing the
      // actual before -> after value (older versions without per-field detail
      // fall back to the key summary in nodeDeltaItem).
      if (d.field === "configuration" && d.configChanges?.length) {
        for (const c of d.configChanges) {
          items.push({
            key: `cfg-${n.id}-${c.key}`,
            kind: "change",
            content: (
              <span className="flex flex-col gap-1.5">
                <span className="text-muted-foreground">
                  <Quoted value={n.label} />{" "}
                  <span className="px-0.5">·</span>{" "}
                  <span className="font-medium text-foreground">
                    {configFieldLabel(n.actionType, c.key)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <DiffValue tone="before" value={c.before} />
                  <Arrow />
                  <DiffValue tone="after" value={c.after} />
                </span>
              </span>
            ),
          });
        }
        continue;
      }
      items.push(nodeDeltaItem(n, d));
    }
  }
  for (const c of diff.connectionsAdded) {
    items.push({
      key: `cadd-${c.from}-${c.to}`,
      kind: "connect",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Connected <Quoted value={c.from} /> <Arrow /> <Quoted value={c.to} />
        </span>
      ),
    });
  }
  for (const c of diff.connectionsRemoved) {
    items.push({
      key: `crem-${c.from}-${c.to}`,
      kind: "disconnect",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Disconnected <Quoted value={c.from} /> <Arrow />{" "}
          <Quoted value={c.to} />
        </span>
      ),
    });
  }
  return items;
}

const KIND_STYLE: Record<ChangeKind, { Icon: typeof Plus; color: string }> = {
  add: { Icon: Plus, color: "text-keeperhub-green" },
  remove: { Icon: Minus, color: "text-destructive" },
  change: { Icon: Pencil, color: "text-amber-400" },
  connect: { Icon: Link2, color: "text-keeperhub-green" },
  disconnect: { Icon: Unlink, color: "text-destructive" },
  enable: { Icon: Power, color: "text-keeperhub-green" },
  disable: { Icon: PowerOff, color: "text-destructive" },
};

function ChangeRow({ item }: { item: ChangeItem }): React.ReactElement {
  const { Icon, color } = KIND_STYLE[item.kind];
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${color}`} />
      <span>{item.content}</span>
    </li>
  );
}

function VersionRow({
  version,
  isCurrent,
  isPreviewing,
  onView,
}: {
  version: WorkflowVersionSummary;
  isCurrent: boolean;
  isPreviewing: boolean;
  onView: () => void;
}): React.ReactElement {
  // Each row owns its open/closed state. Switching page remounts the rows
  // (keys change), so they naturally collapse.
  const [isExpanded, setIsExpanded] = useState(false);
  // The semantic diff vs the previous version is precomputed and stored, so we
  // can show what each version changed without fetching its snapshot. Versions
  // recorded before this format shipped hold a raw diff and are skipped.
  const diff = isVersionDiff(version.change) ? version.change : null;
  const items = diff ? buildChangeItems(diff) : [];
  return (
    <li
      className={`rounded-xl transition-colors ${
        isExpanded ? "bg-muted/40 ring-1 ring-border/70" : "hover:bg-muted/30"
      }`}
    >
      <button
        className="flex w-full items-start gap-2.5 rounded-xl p-3 text-left"
        onClick={() => setIsExpanded((e) => !e)}
        type="button"
      >
        <ActorAvatar actor={version.changedBy} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-medium text-sm">
              Version {version.version}
            </span>
            {isCurrent && (
              <span className="rounded-full bg-keeperhub-green/15 px-1.5 py-0.5 font-medium text-[10px] text-keeperhub-green">
                Current
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="truncate">{actorLabel(version.changedBy)}</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="flex shrink-0 items-center gap-1">
              <Clock className="size-3" />
              {relativeTime(version.createdAt)}
            </span>
          </span>
        </span>
        <ChevronRight
          className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {/* Animated reveal (grid 0fr -> 1fr) so the box opens smoothly, like the
          right-side panel slide. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 border-border border-t px-4 py-3">
            {items.length > 0 ? (
              <ul className="space-y-2">
                {items.map((item) => (
                  <ChangeRow item={item} key={item.key} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-xs">
                {version.previousVersion === null
                  ? "Initial version."
                  : "No tracked changes."}
              </p>
            )}
            <Button
              disabled={isPreviewing}
              onClick={onView}
              size="sm"
              variant="outline"
            >
              <Eye className="mr-1.5 size-3.5" />
              {isPreviewing ? "Viewing on canvas" : "View on canvas"}
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function VersionHistoryPanel(): React.ReactElement | null {
  const [open, setOpen] = useAtom(versionHistoryOpenAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const previewVersion = useAtomValue(previewVersionAtom);
  const [widthPct, setWidthPct] = useAtom(rightPanelWidthPctAtom);
  const [selectedNode, setSelectedNode] = useAtom(selectedNodeAtom);
  const isResizing = useRef(false);
  const { preview, exitPreview } = useVersionPreview();

  const {
    items: versions,
    meta,
    page,
    setPage,
    loading,
    error,
  } = usePaginatedResource<WorkflowVersionSummary>(
    (p) => api.workflow.getHistory(workflowId ?? "", { page: p, limit: 10 }),
    // Reopening the panel (open toggling) restarts at the newest page.
    `${workflowId}|${open}`,
    { enabled: open && !!workflowId, refetchIntervalMs: 30_000 }
  );


  useEffect(() => {
    if (error) {
      toast.error("Failed to load version history");
    }
  }, [error]);

  // Opening history clears any node selection so the panel isn't covering a
  // config form; a subsequent node click (current version only) then closes
  // the panel to reveal that node's config for editing.
  useEffect(() => {
    if (open) {
      setSelectedNode(null);
    }
  }, [open, setSelectedNode]);

  useEffect(() => {
    if (open && previewVersion === null && selectedNode) {
      setOpen(false);
    }
  }, [open, previewVersion, selectedNode, setOpen]);

  const close = useCallback(async () => {
    await exitPreview();
    setOpen(false);
  }, [exitPreview, setOpen]);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const onMove = (move: MouseEvent) => {
      if (!isResizing.current) {
        return;
      }
      const pct = ((window.innerWidth - move.clientX) / window.innerWidth) * 100;
      setWidthPct(Math.min(50, Math.max(20, pct)));
    };
    const onUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Keep mounted so open/close slides; only fully unmount when no workflow.
  if (!workflowId) {
    return null;
  }

  // The newest version only ever appears on page 1 (descending order).
  const latestVersion = page === 1 ? versions[0]?.version : undefined;
  const groups = groupByDate(versions, (v) => v.createdAt);

  return (
    <aside
      className="fixed top-[calc(6rem+var(--app-banner-height,0px))] right-0 bottom-0 z-30 flex flex-col border-border border-t border-l bg-background shadow-xl transition-transform duration-300 ease-out lg:top-[calc(60px+var(--app-banner-height,0px))]"
      style={{
        width: `${widthPct}%`,
        transform: open ? "translateX(0)" : "translateX(100%)",
      }}
    >
      {/* Drag handle: resizes both right-docked panels (shared width atom).
          Only while open -- when closed the panel is parked off-screen and its
          left-edge button would otherwise protrude at the viewport's right. */}
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: custom resize handle
        <div
          aria-orientation="vertical"
          aria-valuenow={widthPct}
          className="absolute inset-y-0 left-0 z-10 w-3 cursor-col-resize"
          onMouseDown={handleResizeStart}
          role="separator"
          tabIndex={0}
        >
          <div className="absolute inset-y-0 left-0 w-px bg-border" />
          {/* Collapse button mirrors the node-config panel's handle affordance. */}
          <button
            className="-translate-x-1/2 absolute top-3 left-0 flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title="Close version history"
            type="button"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 border-border border-b px-4 py-3">
        <GitBranch className="size-4 text-muted-foreground" />
        <h2 className="font-semibold text-sm">Version history</h2>
      </div>

      <div className="thin-scrollbar flex-1 overflow-y-auto p-3">
        {loading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div className="flex items-center gap-2.5" key={i}>
                <Skeleton className="size-7 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && versions.length === 0 && (
          <p className="p-2 text-muted-foreground text-sm">
            No versions recorded yet.
          </p>
        )}
        {groups.map((group) => (
          <div className="mb-3" key={group.label}>
            <p className="px-2.5 py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.label}
            </p>
            <ul className="space-y-2">
              {group.items.map((v) => (
                <VersionRow
                  isCurrent={v.version === latestVersion}
                  isPreviewing={previewVersion === v.version}
                  key={v.version}
                  onView={() => preview(v.version)}
                  version={v}
                />
              ))}
            </ul>
          </div>
        ))}
        {meta && (
          <div className="px-1 pt-2">
            <Pager meta={meta} onPage={setPage} unit="versions" />
          </div>
        )}
      </div>
    </aside>
  );
}
