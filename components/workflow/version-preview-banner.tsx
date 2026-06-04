"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Eye } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import {
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  nodesAtom,
  previewVersionAtom,
} from "@/lib/workflow/store";

/**
 * Read-only banner shown while the canvas is previewing a historical version
 * (set from the version-history overlay's "View on canvas"). Autosave is
 * suppressed via previewVersionAtom, so the live workflow is untouched until
 * the user explicitly restores. "Exit preview" reloads the live definition.
 */
export function VersionPreviewBanner(): React.ReactElement | null {
  const previewVersion = useAtomValue(previewVersionAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setPreviewVersion = useSetAtom(previewVersionAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const [busy, setBusy] = useState(false);

  if (previewVersion === null || !workflowId) {
    return null;
  }

  const exit = async () => {
    setBusy(true);
    try {
      const live = await api.workflow.getById(workflowId);
      setNodes(live.nodes);
      setEdges(live.edges);
    } catch {
      toast.error("Failed to reload the current version");
    } finally {
      setPreviewVersion(null);
      setHasUnsavedChanges(false);
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await api.workflow.update(workflowId, { nodes, edges });
      setPreviewVersion(null);
      setHasUnsavedChanges(false);
      toast.success(`Restored version ${previewVersion}`);
    } catch {
      toast.error("Failed to restore version");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="-translate-x-1/2 fixed top-[calc(var(--header-height)+12px)] left-1/2 z-50 flex items-center gap-3 rounded-full border border-amber-500/40 bg-amber-500/10 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur">
      <span className="flex items-center gap-1.5 font-medium text-amber-600 text-sm dark:text-amber-400">
        <Eye className="size-4" />
        Viewing version {previewVersion} (read-only)
      </span>
      <Button
        disabled={busy}
        onClick={exit}
        size="sm"
        variant="ghost"
      >
        Exit preview
      </Button>
      <Button disabled={busy} onClick={restore} size="sm">
        Restore this version
      </Button>
    </div>
  );
}
