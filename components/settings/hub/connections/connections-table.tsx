"use client";

import { History, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { IntegrationActivityOverlay } from "@/components/overlays/integration-activity-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Integration } from "@/lib/api-client";
import type { LabelledIntegration } from "../hooks/use-connections";
import { ConfirmRow } from "../confirm-row";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";

export function ConnectionsTable({
  connections,
  canManage,
  onEdit,
  onRemove,
}: {
  connections: LabelledIntegration[];
  canManage: boolean;
  onEdit: (integration: Integration) => void;
  onRemove: (integration: Integration) => Promise<void>;
}): React.ReactElement {
  const { push } = useOverlay();
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Service</TableHead>
          <TableHead>Label</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {connections.map((connection) => (
          <TableRow className={SETTINGS_ROW} key={connection.id}>
            <TableCell>
              <span className="flex items-center gap-2.5 font-medium">
                <IntegrationIcon
                  className="size-4 shrink-0"
                  integration={connection.type}
                />
                {connection.label}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {connection.name}
            </TableCell>
            <TableCell className="text-right">
              {confirming === connection.id ? (
                <ConfirmRow
                  label="Remove this connection?"
                  onCancel={() => setConfirming(null)}
                  onConfirm={async () => {
                    await onRemove(connection);
                    setConfirming(null);
                  }}
                />
              ) : (
                <div className="flex justify-end gap-1">
                  <Button
                    aria-label="Activity"
                    onClick={() =>
                      push(IntegrationActivityOverlay, {
                        integration: connection,
                      })
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <History className="size-4" />
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        aria-label="Edit"
                        onClick={() => onEdit(connection)}
                        size="icon"
                        variant="ghost"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        aria-label="Remove"
                        onClick={() => setConfirming(connection.id)}
                        size="icon"
                        variant="ghost"
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
