"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleLabel } from "@/lib/organization/role-label";
import { ConfirmRow } from "../confirm-row";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";
import type { OrgMember } from "../hooks/use-org-members";

export function MembersTable({
  members,
  currentMemberId,
  canManage,
  updatingId,
  onRoleChange,
  onRemove,
}: {
  members: OrgMember[];
  currentMemberId: string | null;
  canManage: boolean;
  updatingId: string | null;
  onRoleChange: (memberId: string, role: string) => Promise<void>;
  onRemove: (member: OrgMember) => Promise<void>;
}): React.ReactElement {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Member</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const isSelf = member.id === currentMemberId;
          // One owner per org (DB-enforced); transferring ownership happens in
          // the leave flow, so the picker only offers the two editable roles.
          const roleEditable =
            canManage && !isSelf && member.role !== "owner";
          return (
            <TableRow className={SETTINGS_ROW} key={member.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="size-8">
                    <AvatarImage
                      alt={member.user.name}
                      src={member.user.image ?? ""}
                    />
                    <AvatarFallback className="text-xs">
                      {member.user.name?.slice(0, 2).toUpperCase() ?? "??"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 truncate font-medium">
                      {member.user.name}
                      {isSelf && (
                        <span className="rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
                          You
                        </span>
                      )}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">
                      {member.user.email}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {roleEditable ? (
                  <Select
                    disabled={updatingId === member.id}
                    onValueChange={(role) => onRoleChange(member.id, role)}
                    value={member.role}
                  >
                    <SelectTrigger className="h-8 w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="rounded-full border px-2 py-0.5 text-[0.6875rem]">
                    {roleLabel(member.role)}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(member.createdAt).toLocaleDateString()}
              </TableCell>
              <TableCell className="text-right">
                {confirming === member.id ? (
                  <ConfirmRow
                    label={`Remove ${member.user.name}?`}
                    onCancel={() => setConfirming(null)}
                    onConfirm={async () => {
                      await onRemove(member);
                      setConfirming(null);
                    }}
                  />
                ) : (
                  canManage &&
                  !isSelf && (
                    <Button
                      aria-label={`Remove ${member.user.name}`}
                      onClick={() => setConfirming(member.id)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  )
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
