"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Inline destructive confirmation. Keeps a irreversible action behind a second
 * click without opening a dialog for it.
 */
export function ConfirmRow({
  label,
  confirmLabel = "Remove",
  onConfirm,
  onCancel,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <Button disabled={busy} onClick={run} size="sm" variant="destructive">
        {busy ? "Removing..." : confirmLabel}
      </Button>
      <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
        Cancel
      </Button>
    </div>
  );
}
