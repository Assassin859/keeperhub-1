"use client";

import { useAtomValue } from "jotai";
import { Eye } from "lucide-react";
import { useState } from "react";
import { currentWorkflowIdAtom, previewVersionAtom } from "@/lib/workflow/store";
import { useVersionPreview } from "@/lib/workflow/use-version-preview";

/**
 * Read-only banner shown while the canvas previews a historical version (set
 * from the version-history panel's "View on canvas", or by opening a
 * `?version=` URL). Styled as the app's segmented navbar pill. Restore lives
 * here only -- the panel no longer duplicates it. Autosave stays suppressed
 * via previewVersionAtom, so the live workflow is untouched until restore.
 */
export function VersionPreviewBanner(): React.ReactElement | null {
  const previewVersion = useAtomValue(previewVersionAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const { exitPreview, restore } = useVersionPreview();
  const [busy, setBusy] = useState(false);

  if (previewVersion === null || !workflowId) {
    return null;
  }

  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="-translate-x-1/2 fixed top-[calc(var(--header-height,60px)+12px)] left-1/2 z-50 flex h-9 items-center rounded-md border bg-secondary text-secondary-foreground shadow-md">
      <span className="flex h-full items-center gap-1.5 rounded-l-md px-3 font-medium text-sm">
        <Eye className="size-4 text-amber-400" />
        Viewing version {previewVersion}
      </span>
      <div className="h-5 w-px bg-border" />
      <button
        className="flex h-full items-center px-3 text-muted-foreground text-sm transition-colors hover:bg-black/5 hover:text-foreground disabled:opacity-50 dark:hover:bg-white/5"
        disabled={busy}
        onClick={run(exitPreview)}
        type="button"
      >
        Exit preview
      </button>
      <div className="h-5 w-px bg-border" />
      <button
        className="flex h-full items-center rounded-r-md px-3 font-medium text-sm transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
        disabled={busy}
        onClick={run(() => restore(previewVersion))}
        type="button"
      >
        Restore this version
      </button>
    </div>
  );
}
