"use client";

import { roleLabel } from "@/lib/organization/role-label";
import type { OrgMember } from "./hooks/use-org-members";
import { StatTile } from "./section";

export function MemberStats({
  members,
  pendingCount,
  role,
}: {
  members: OrgMember[];
  pendingCount: number;
  role: string | undefined;
}): React.ReactElement {
  const owners = members.filter((m) => m.role === "owner").length;
  const admins = members.filter((m) => m.role === "admin").length;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatTile
        hint={`${owners} owner${owners === 1 ? "" : "s"}, ${admins} admin${admins === 1 ? "" : "s"}`}
        label="Seats in use"
        value={String(members.length)}
      />
      <StatTile
        hint={pendingCount > 0 ? "Awaiting acceptance" : "None waiting"}
        label="Pending invitations"
        tone={pendingCount > 0 ? "warning" : "neutral"}
        value={String(pendingCount)}
      />
      <StatTile
        hint="Decides what you can change here"
        label="Your role"
        value={roleLabel(role) ?? "--"}
      />
    </div>
  );
}
