"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { workflowExportV1Schema } from "@/lib/workflow/export-schema";
import type { OverlayComponentProps } from "./types";

type ImportWorkflowOverlayProps = OverlayComponentProps<{
  onImported?: (workflowId: string) => void;
}>;

export function ImportWorkflowOverlay({
  overlayId,
  onImported,
}: ImportWorkflowOverlayProps) {
  const { closeAll } = useOverlay();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [parsedFile, setParsedFile] = useState<unknown>(null);
  const [bindingCount, setBindingCount] = useState(0);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setParsedFile(null);
    setBindingCount(0);

    try {
      const text = await file.text();
      const json = JSON.parse(text) as unknown;

      const result = workflowExportV1Schema.safeParse(json);
      if (!result.success) {
        const firstIssue = result.error.issues[0];
        const path = firstIssue?.path.join(".") || "(root)";
        setError(
          `Invalid workflow export at ${path}: ${firstIssue?.message ?? "validation failed"}`
        );
        return;
      }

      setParsedFile(result.data);
      setBindingCount(result.data.integrationBindings.length);
    } catch (e) {
      setError(
        e instanceof Error ? `Could not read file: ${e.message}` : "Could not read file"
      );
    }
  }, []);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handleFile(file).catch(() => {
          // handled inside handleFile
        });
      }
    },
    [handleFile]
  );

  const handleImport = useCallback(async () => {
    if (!parsedFile) {
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.workflow.import(
        parsedFile as Parameters<typeof api.workflow.import>[0]
      );
      toast.success("Workflow imported");
      closeAll();
      if (onImported) {
        onImported(created.id);
      } else {
        router.push(`/workflows/${created.id}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to import workflow";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [parsedFile, onImported, router, closeAll]);

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: closeAll },
        {
          label: submitting ? "Importing..." : "Import",
          onClick: handleImport,
          loading: submitting,
          disabled: !parsedFile || submitting,
        },
      ]}
      overlayId={overlayId}
      title="Import Workflow"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Upload className="size-5" />
        <p className="text-sm">
          Import a workflow from a JSON file exported from KeeperHub.
        </p>
      </div>

      <div className="mt-4 space-y-2">
        <Label htmlFor="workflow-import-file">Workflow JSON file</Label>
        <Input
          accept="application/json,.json"
          id="workflow-import-file"
          onChange={handleFileChange}
          ref={inputRef}
          type="file"
        />
      </div>

      {fileName && !error && (
        <p className="mt-3 text-muted-foreground text-sm">
          Selected: <span className="font-medium text-foreground">{fileName}</span>
          {bindingCount > 0 && (
            <>
              {" "}
              -- {bindingCount} integration{bindingCount === 1 ? "" : "s"} need
              to be reconnected after import.
            </>
          )}
        </p>
      )}

      {error && (
        <p
          className={cn(
            "mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm"
          )}
        >
          {error}
        </p>
      )}
    </Overlay>
  );
}
