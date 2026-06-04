"use client";

import { useSetAtom } from "jotai";
import { History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeDiffEditor } from "@/components/ui/code-diff-editor";
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
} from "@/lib/workflow/store";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type Props = {
  overlayId: string;
  workflowId: string;
};

function actorLabel(v: WorkflowVersionSummary): string {
  const a = v.changedBy;
  if (!a) {
    return "System";
  }
  return a.name || a.email || a.id;
}

// The fields worth showing in the diff -- the meaningful definition, not
// cosmetic canvas state.
function diffText(wf: SavedWorkflow | null): string {
  if (!wf) {
    return "";
  }
  return JSON.stringify(
    {
      name: wf.name,
      description: wf.description,
      visibility: wf.visibility,
      enabled: wf.enabled,
      nodes: wf.nodes,
      edges: wf.edges,
    },
    null,
    2
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

  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [current, setCurrent] = useState<SavedWorkflow | null>(null);
  const [previous, setPrevious] = useState<SavedWorkflow | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.workflow
      .getHistory(workflowId)
      .then((res) => {
        if (active) {
          setVersions(res.versions);
        }
      })
      .catch(() => {
        if (active) {
          toast.error("Failed to load version history");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [workflowId]);

  const selectVersion = useCallback(
    async (v: WorkflowVersionSummary) => {
      setSelected(v.version);
      setCurrent(null);
      setPrevious(null);
      try {
        const [sel, prev] = await Promise.all([
          api.workflow.getById(workflowId, { version: v.version }),
          v.previousVersion
            ? api.workflow.getById(workflowId, { version: v.previousVersion })
            : Promise.resolve(null),
        ]);
        setCurrent(sel);
        setPrevious(prev);
      } catch {
        toast.error("Failed to load version snapshot");
      }
    },
    [workflowId]
  );

  const restore = useCallback(async () => {
    if (!current) {
      return;
    }
    setRestoring(true);
    try {
      await api.workflow.update(workflowId, {
        name: current.name,
        description: current.description,
        nodes: current.nodes,
        edges: current.edges,
        visibility: current.visibility,
        enabled: current.enabled,
      });
      // Reflect the restored definition on the live canvas (shared atom store).
      setNodes(current.nodes);
      setEdges(current.edges);
      setHasUnsavedChanges(false);
      toast.success(`Restored version ${selected}`);
      pop();
    } catch {
      toast.error("Failed to restore version");
    } finally {
      setRestoring(false);
    }
  }, [
    current,
    workflowId,
    selected,
    setNodes,
    setEdges,
    setHasUnsavedChanges,
    pop,
  ]);

  return (
    <Overlay
      actions={[
        { label: "Close", onClick: pop, variant: "outline" },
        {
          label: restoring ? "Restoring..." : `Restore version ${selected ?? ""}`,
          onClick: restore,
          disabled: !current || restoring,
          loading: restoring,
        },
      ]}
      description="Review and restore previous versions of this workflow."
      overlayId={overlayId}
      title="Version history"
    >
      <div className="flex h-[60vh] gap-4">
        <ul className="thin-scrollbar w-64 shrink-0 space-y-1 overflow-y-auto border-border border-r pr-2">
          {loading && (
            <li className="p-2 text-muted-foreground text-sm">Loading...</li>
          )}
          {!loading && versions.length === 0 && (
            <li className="p-2 text-muted-foreground text-sm">
              No versions recorded yet.
            </li>
          )}
          {versions.map((v) => (
            <li key={v.version}>
              <button
                className={`flex w-full flex-col items-start rounded-md p-2 text-left text-sm hover:bg-muted ${
                  selected === v.version ? "bg-muted" : ""
                }`}
                onClick={() => selectVersion(v)}
                type="button"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <History className="size-3.5" /> v{v.version}
                  <span className="text-muted-foreground text-xs">
                    {v.source}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {actorLabel(v)} ·{" "}
                  {new Date(v.createdAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          {current ? (
            <CodeDiffEditor
              modified={diffText(current)}
              original={diffText(previous)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              <RotateCcw className="mr-2 size-4" />
              Select a version to see what changed.
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
