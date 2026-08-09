"use client";

import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import type { OrganizationWithRole } from "@/lib/hooks/use-organization";
import { roleLabel } from "@/lib/organization/role-label";
import { cn } from "@/lib/utils";
import { useRenameDraft } from "./hooks/use-rename-draft";
import { SETTINGS_ROW } from "./section";

export function OrgRow({
  org,
  isActive,
  memberCount,
  onSwitch,
  onRename,
}: {
  org: OrganizationWithRole;
  isActive: boolean;
  memberCount: number | null;
  onSwitch: () => void;
  onRename: (name: string) => Promise<boolean>;
}): React.ReactElement {
  const draft = useRenameDraft(org.name, onRename);
  // Renaming acts on the organization you are currently working in, so the
  // control only appears on the active row. Every other row offers the switch
  // that makes it active first.
  const canRename = isActive && org.role === "owner";

  return (
    <TableRow
      // The active-row tint rides the same inset fill as hover, so it
      // clears the dividers too.
      className={cn(SETTINGS_ROW, isActive && "[&>td]:before:bg-muted/40")}
      data-testid="settings-org-row"
    >
      <TableCell>
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
            <Building2 className="size-4" />
          </span>
          {draft.editing ? (
            <Input
              className="h-8 max-w-64"
              onChange={(e) => draft.set(e.target.value)}
              value={draft.value ?? ""}
            />
          ) : (
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 font-medium">
                <span className="truncate">{org.name}</span>
                {isActive && (
                  <span className="rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
                    Current
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-muted-foreground text-xs">
                {org.slug}
              </span>
            </div>
          )}
        </div>
      </TableCell>
      <TableCell>
        <span className="rounded-full border px-2 py-0.5 text-[0.6875rem]">
          {roleLabel(org.role)}
        </span>
      </TableCell>
      <TableCell className="tabular-nums">{memberCount ?? "--"}</TableCell>
      <TableCell className="text-right">
        {draft.editing ? (
          <div className="flex justify-end gap-2">
            <Button disabled={draft.saving} onClick={draft.commit} size="sm">
              Save
            </Button>
            <Button onClick={draft.cancel} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            {canRename && (
              <Button onClick={draft.start} size="sm" variant="outline">
                Rename
              </Button>
            )}
            {!isActive && (
              <Button onClick={onSwitch} size="sm" variant="outline">
                Switch to
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
