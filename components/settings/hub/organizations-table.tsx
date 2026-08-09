"use client";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OrganizationWithRole } from "@/lib/hooks/use-organization";
import { OrgRow } from "./org-row";
import { SETTINGS_HEAD_ROW } from "./section";

export function OrganizationsTable({
  organizations,
  activeOrgId,
  memberCounts,
  onSwitch,
  onRename,
}: {
  organizations: OrganizationWithRole[];
  activeOrgId: string | null;
  memberCounts: Record<string, number>;
  onSwitch: (organizationId: string) => void;
  onRename: (organizationId: string, name: string) => Promise<boolean>;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Organization</TableHead>
          <TableHead>Your role</TableHead>
          <TableHead>Members</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {organizations.map((org) => (
          <OrgRow
            isActive={org.id === activeOrgId}
            key={org.id}
            memberCount={memberCounts[org.id] ?? null}
            onRename={(name) => onRename(org.id, name)}
            onSwitch={() => onSwitch(org.id)}
            org={org}
          />
        ))}
      </TableBody>
    </Table>
  );
}
