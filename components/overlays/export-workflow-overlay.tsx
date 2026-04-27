"use client";

import { Download } from "lucide-react";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

type ExportWorkflowOverlayProps = OverlayComponentProps<{
  onExport: () => void;
  isDownloading?: boolean;
}>;

export function ExportWorkflowOverlay({
  overlayId,
  onExport,
  isDownloading,
}: ExportWorkflowOverlayProps) {
  const { closeAll } = useOverlay();

  const handleExport = () => {
    closeAll();
    onExport();
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: closeAll },
        {
          label: isDownloading ? "Exporting..." : "Export JSON",
          onClick: handleExport,
          loading: isDownloading,
        },
      ]}
      overlayId={overlayId}
      title="Export Workflow"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Download className="size-5" />
        <p className="text-sm">
          Download this workflow as a JSON file you can re-import into another
          KeeperHub instance or share with your team.
        </p>
      </div>

      <p className="mt-4 text-muted-foreground text-sm">
        Credentials are not included in the export. Imported workflows preserve
        the structure of nodes and edges; you will need to reconnect any
        integrations after import.
      </p>
    </Overlay>
  );
}
