"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDeleteDialog } from "../confirm-delete-dialog";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";

export type GroupingRow = {
  id: string;
  name: string;
  color: string | null;
  workflowCount: number;
  description?: string | null;
};

export function GroupingTable({
  rows,
  unit,
  canManage,
  onEdit,
  onDelete,
}: {
  rows: GroupingRow[];
  /** Singular noun for the count column, e.g. "workflow". */
  unit: string;
  canManage: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState<GroupingRow | null>(null);

  return (
    <>
      <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Name</TableHead>
          <TableHead>Workflows</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow className={SETTINGS_ROW} key={row.id}>
            <TableCell>
              <div className="flex items-center gap-2.5">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: row.color ?? "var(--color-text-muted)",
                  }}
                />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{row.name}</span>
                  {row.description && (
                    <span className="truncate text-muted-foreground text-xs">
                      {row.description}
                    </span>
                  )}
                </div>
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {row.workflowCount}
            </TableCell>
            <TableCell className="text-right">
              {canManage && (
                  <div className="flex justify-end gap-1">
                    <Button
                      aria-label={`Edit ${row.name}`}
                      onClick={() => onEdit(row.id)}
                      size="icon"
                      variant="ghost"
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      aria-label={`Delete ${row.name}`}
                      onClick={() => setPending(row)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      </Table>

      <ConfirmDeleteDialog
        confirmLabel="Delete"
        description={`${pending?.name ?? "This " + unit} is removed from every workflow using it. The workflows themselves stay.`}
        onConfirm={async () => {
          if (pending) {
            await onDelete(pending.id);
          }
        }}
        onOpenChange={(next) => !next && setPending(null)}
        open={pending !== null}
        title={`Delete ${unit}`}
      />
    </>
  );
}
