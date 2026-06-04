"use client";

import { useSetAtom } from "jotai";
import { ArrowRight, Clock, GitBranch, Minus, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  api,
  type SavedWorkflow,
  type WorkflowVersionSummary,
} from "@/lib/api-client";
import {
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
  previewVersionAtom,
} from "@/lib/workflow/store";
import { computeVersionDiff, type VersionDiff } from "@/lib/workflow/version-diff";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type Props = { overlayId: string; workflowId: string };

type ChangeItem = {
  key: string;
  kind: "add" | "remove" | "change";
  content: ReactNode;
};

// Inline arrow icon for "from -> to" relations (no glyph arrows).
function Arrow(): React.ReactElement {
  return (
    <ArrowRight className="inline size-3 shrink-0 text-muted-foreground" />
  );
}

function Quoted({ value }: { value: string }): React.ReactElement {
  return <span className="font-medium">&quot;{value || "untitled"}&quot;</span>;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) {
    return "just now";
  }
  const mins = Math.round(diffSec / 60);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(iso).toLocaleDateString();
}

function actorName(v: WorkflowVersionSummary): string {
  return v.changedBy?.name || v.changedBy?.email || "System";
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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
  return { key: "set-description", kind: "change", content: "Description updated" };
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
        : "text-amber-500";
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} />
      <span>{item.content}</span>
    </li>
  );
}

export function WorkflowVersionHistoryOverlay({
  overlayId,
  workflowId,
}: Props): React.ReactElement {
  const { pop } = useOverlay();
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const setPreviewVersion = useSetAtom(previewVersionAtom);

  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<WorkflowVersionSummary | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreSnapshot, setRestoreSnapshot] = useState<SavedWorkflow | null>(
    null
  );

  useEffect(() => {
    let active = true;
    api.workflow
      .getHistory(workflowId)
      .then((res) => {
        if (active) {
          setVersions(res.versions);
        }
      })
      .catch(() => active && toast.error("Failed to load version history"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [workflowId]);

  const select = useCallback(
    async (v: WorkflowVersionSummary) => {
      setSelected(v);
      setDiff(null);
      setRestoreSnapshot(null);
      setDiffLoading(true);
      try {
        const [sel, prev] = await Promise.all([
          api.workflow.getById(workflowId, { version: v.version }),
          v.previousVersion
            ? api.workflow.getById(workflowId, { version: v.previousVersion })
            : Promise.resolve(null),
        ]);
        setRestoreSnapshot(sel);
        setDiff(computeVersionDiff(prev, sel));
      } catch {
        toast.error("Failed to load version");
      } finally {
        setDiffLoading(false);
      }
    },
    [workflowId]
  );

  const restore = useCallback(async () => {
    if (!(restoreSnapshot && selected)) {
      return;
    }
    setRestoring(true);
    try {
      await api.workflow.update(workflowId, {
        name: restoreSnapshot.name,
        description: restoreSnapshot.description,
        nodes: restoreSnapshot.nodes,
        edges: restoreSnapshot.edges,
        visibility: restoreSnapshot.visibility,
        enabled: restoreSnapshot.enabled,
      });
      setNodes(restoreSnapshot.nodes);
      setEdges(restoreSnapshot.edges);
      setHasUnsavedChanges(false);
      toast.success(`Restored version ${selected.version}`);
      pop();
    } catch {
      toast.error("Failed to restore version");
    } finally {
      setRestoring(false);
    }
  }, [
    restoreSnapshot,
    selected,
    workflowId,
    setNodes,
    setEdges,
    setHasUnsavedChanges,
    pop,
  ]);

  const view = useCallback(() => {
    if (!(restoreSnapshot && selected)) {
      return;
    }
    setPreviewVersion(selected.version);
    setNodes(restoreSnapshot.nodes);
    setEdges(restoreSnapshot.edges);
    pop();
  }, [restoreSnapshot, selected, setPreviewVersion, setNodes, setEdges, pop]);

  const items = diff ? buildChangeItems(diff) : [];

  return (
    <Overlay
      actions={[
        { label: "Close", onClick: pop, variant: "outline" },
        {
          label: "View on canvas",
          onClick: view,
          disabled: !restoreSnapshot,
          variant: "outline",
        },
        {
          label: restoring
            ? "Restoring..."
            : selected
              ? `Restore v${selected.version}`
              : "Restore",
          onClick: restore,
          disabled: !restoreSnapshot || restoring,
          loading: restoring,
        },
      ]}
      description="Review and restore previous versions of this workflow."
      overlayId={overlayId}
      title="Version history"
    >
      <div className="flex h-[58vh] gap-5">
        {/* Timeline */}
        <ul className="thin-scrollbar w-64 shrink-0 space-y-1 overflow-y-auto pr-1">
          {loading && (
            <li className="p-2 text-muted-foreground text-sm">Loading...</li>
          )}
          {!loading && versions.length === 0 && (
            <li className="p-2 text-muted-foreground text-sm">
              No versions recorded yet.
            </li>
          )}
          {versions.map((v, i) => {
            const isSelected = selected?.version === v.version;
            return (
              <li key={v.version}>
                <button
                  className={`flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-muted ${
                    isSelected ? "bg-muted" : ""
                  }`}
                  onClick={() => select(v)}
                  type="button"
                >
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted-foreground/10 text-muted-foreground">
                    <GitBranch className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-sm">
                        Version {v.version}
                      </span>
                      {i === 0 && (
                        <span className="rounded-full bg-keeperhub-green/15 px-1.5 py-0.5 font-medium text-[10px] text-keeperhub-green">
                          Current
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-muted-foreground text-xs">
                      {actorName(v)}
                    </span>
                    <span className="flex items-center gap-1 text-muted-foreground text-xs">
                      <Clock className="size-3" />
                      {timeAgo(v.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Change detail */}
        <div className="thin-scrollbar min-w-0 flex-1 overflow-y-auto border-border border-l pl-5">
          {selected ? (
            <div>
              <div className="mb-4">
                <h3 className="font-semibold text-base">
                  Version {selected.version}
                </h3>
                <p className="text-muted-foreground text-xs">
                  {actorName(selected)} ·{" "}
                  {new Date(selected.createdAt).toLocaleString()}
                </p>
              </div>
              {diffLoading && (
                <p className="text-muted-foreground text-sm">Loading changes...</p>
              )}
              {!diffLoading &&
                (selected.previousVersion === null ? (
                  <p className="text-muted-foreground text-sm">
                    Initial version of this workflow.
                  </p>
                ) : items.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No meaningful changes (layout only).
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {items.map((item) => (
                      <ChangeRow item={item} key={item.key} />
                    ))}
                  </ul>
                ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-muted-foreground text-sm">
              Select a version to see what changed.
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
