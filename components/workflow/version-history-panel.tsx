"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ArrowRight,
  ChevronRight,
  Clock,
  GitBranch,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ActorAvatar, actorLabel } from "@/components/activity/actor-avatar";
import { relativeTime } from "@/components/settings/session-format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  type SavedWorkflow,
  type WorkflowVersionSummary,
} from "@/lib/api-client";
import { Pager } from "@/components/activity/pager";
import { groupByDate } from "@/lib/activity/time-groups";
import { usePaginatedResource } from "@/lib/hooks/use-paginated-resource";
import {
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
  previewVersionAtom,
  rightPanelWidthPctAtom,
  selectedNodeAtom,
  versionHistoryOpenAtom,
} from "@/lib/workflow/store";
import {
  type VersionDiff,
} from "@/lib/workflow/version-diff";

type ChangeItem = {
  key: string;
  kind: "add" | "remove" | "change";
  content: ReactNode;
};

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function Arrow(): React.ReactElement {
  return (
    <ArrowRight className="inline size-3 shrink-0 text-muted-foreground" />
  );
}

function Quoted({ value }: { value: string }): React.ReactElement {
  return <span className="font-medium">&quot;{value || "untitled"}&quot;</span>;
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
    return {
      key: "set-enabled",
      kind: "change",
      content: s.after === "true" ? "Workflow enabled" : "Workflow disabled",
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
  const who = (
    <>
      {cap(n.nodeType)} <Quoted value={n.label} />
    </>
  );
  if (d.field === "name") {
    return {
      key,
      kind: "change",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Renamed {cap(n.nodeType)}: <Quoted value={d.before ?? ""} /> <Arrow />{" "}
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
    return {
      key,
      kind: "change",
      content: d.after === "true" ? <>Enabled {who}</> : <>Disabled {who}</>,
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
          Added {cap(n.nodeType)} <Quoted value={n.label} />
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
          Removed {cap(n.nodeType)} <Quoted value={n.label} />
        </>
      ),
    });
  }
  for (const n of diff.nodesChanged) {
    for (const d of n.deltas) {
      items.push(nodeDeltaItem(n, d));
    }
  }
  for (const c of diff.connectionsAdded) {
    items.push({
      key: `cadd-${c.from}-${c.to}`,
      kind: "add",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Connected {c.from} <Arrow /> {c.to}
        </span>
      ),
    });
  }
  for (const c of diff.connectionsRemoved) {
    items.push({
      key: `crem-${c.from}-${c.to}`,
      kind: "remove",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Disconnected {c.from} <Arrow /> {c.to}
        </span>
      ),
    });
  }
  return items;
}

function ChangeRow({ item }: { item: ChangeItem }): React.ReactElement {
  const Icon =
    item.kind === "add" ? Plus : item.kind === "remove" ? Minus : Pencil;
  const color =
    item.kind === "add"
      ? "text-keeperhub-green"
      : item.kind === "remove"
        ? "text-destructive"
        : "text-amber-400";
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
  isSelected,
  onSelect,
}: {
  version: WorkflowVersionSummary;
  isCurrent: boolean;
  isSelected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  // The semantic diff vs the previous version is precomputed and stored, so we
  // can show what each version changed without fetching its snapshot. Versions
  // recorded before this format shipped hold a raw diff and are skipped.
  const diff = isVersionDiff(version.change) ? version.change : null;
  const items = diff ? buildChangeItems(diff) : [];
  return (
    <li>
      <button
        className={`flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition-colors hover:bg-muted ${
          isSelected ? "bg-muted" : ""
        }`}
        onClick={onSelect}
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
          <span className="mt-0.5 block truncate text-muted-foreground text-xs">
            {actorLabel(version.changedBy)}
          </span>
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <Clock className="size-3" />
            {relativeTime(version.createdAt)}
          </span>
        </span>
      </button>
      {version.previousVersion !== null && items.length > 0 && (
        <div className="mt-1 mb-1 ml-9 border-border border-l pl-3">
          <ul className="space-y-1.5 py-1">
            {items.map((item) => (
              <ChangeRow item={item} key={item.key} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function VersionHistoryPanel(): React.ReactElement | null {
  const [open, setOpen] = useAtom(versionHistoryOpenAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const [previewVersion, setPreviewVersion] = useAtom(previewVersionAtom);
  const [widthPct, setWidthPct] = useAtom(rightPanelWidthPctAtom);
  const [selectedNode, setSelectedNode] = useAtom(selectedNodeAtom);
  const isResizing = useRef(false);

  const [selected, setSelected] = useState<WorkflowVersionSummary | null>(null);
  const [snapshot, setSnapshot] = useState<SavedWorkflow | null>(null);
  const [restoring, setRestoring] = useState(false);

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
    { enabled: open && !!workflowId }
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

  const exitPreview = useCallback(async () => {
    if (previewVersion === null || !workflowId) {
      return;
    }
    try {
      const live = await api.workflow.getById(workflowId);
      setNodes(live.nodes);
      setEdges(live.edges);
    } catch {
      // best-effort
    } finally {
      setPreviewVersion(null);
      setHasUnsavedChanges(false);
    }
  }, [
    previewVersion,
    workflowId,
    setNodes,
    setEdges,
    setPreviewVersion,
    setHasUnsavedChanges,
  ]);

  const close = useCallback(async () => {
    await exitPreview();
    setSelected(null);
    setOpen(false);
  }, [exitPreview, setOpen]);

  const select = useCallback(
    async (v: WorkflowVersionSummary) => {
      if (!workflowId) {
        return;
      }
      setSelected(v);
      setSnapshot(null);
      try {
        const sel = await api.workflow.getById(workflowId, {
          version: v.version,
        });
        setSnapshot(sel);
        // Live preview on the canvas (autosave is suppressed while previewing).
        setPreviewVersion(v.version);
        setNodes(sel.nodes);
        setEdges(sel.edges);
      } catch {
        toast.error("Failed to load version");
      }
    },
    [workflowId, setPreviewVersion, setNodes, setEdges]
  );

  const restore = useCallback(async () => {
    if (!(snapshot && selected && workflowId)) {
      return;
    }
    setRestoring(true);
    try {
      await api.workflow.update(workflowId, {
        name: snapshot.name,
        description: snapshot.description,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        visibility: snapshot.visibility,
        enabled: snapshot.enabled,
      });
      setNodes(snapshot.nodes);
      setEdges(snapshot.edges);
      setPreviewVersion(null);
      setHasUnsavedChanges(false);
      toast.success(`Restored version ${selected.version}`);
      setOpen(false);
      setSelected(null);
    } catch {
      toast.error("Failed to restore version");
    } finally {
      setRestoring(false);
    }
  }, [
    snapshot,
    selected,
    workflowId,
    setNodes,
    setEdges,
    setPreviewVersion,
    setHasUnsavedChanges,
    setOpen,
  ]);

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
  const canRestore =
    selected !== null && selected.version !== latestVersion && !!snapshot;

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
          <div className="mb-2" key={group.label}>
            <p className="px-2.5 py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((v) => (
                <VersionRow
                  isCurrent={v.version === latestVersion}
                  isSelected={selected?.version === v.version}
                  key={v.version}
                  onSelect={() => select(v)}
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

      <div className="border-border border-t p-3">
        <Button
          className="w-full"
          disabled={!canRestore || restoring}
          onClick={restore}
        >
          <RotateCcw className="mr-1.5 size-4" />
          {restoring
            ? "Restoring..."
            : selected && canRestore
              ? `Restore version ${selected.version}`
              : "Restore"}
        </Button>
      </div>
    </aside>
  );
}
