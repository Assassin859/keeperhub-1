"use client";

import { UserPlus } from "lucide-react";
import { useState } from "react";
import { useSession } from "@/lib/auth-client";
import { InviteMemberForm } from "@/components/organization/invite-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOrgMembers } from "./hooks/use-org-members";
import { InvitationsCard } from "./invitations-card";
import { MemberStats } from "./member-stats";
import { MembersTable } from "./members/members-table";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { RowsSkeleton, StatTilesSkeleton } from "./skeletons";

export function MembersSection(): React.ReactElement {
  const { organizationName, isAdmin, role } = useSettingsContext();
  const { data: session } = useSession();
  const members = useOrgMembers();
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const currentMemberId =
    members.members.find((m) => m.userId === session?.user?.id)?.id ?? null;

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? members.members.filter(
        (m) =>
          m.user.name?.toLowerCase().includes(needle) ||
          m.user.email?.toLowerCase().includes(needle)
      )
    : members.members;

  return (
    <>
      <SectionHeader
        action={
          isAdmin ? (
            <Button onClick={() => setInviting((v) => !v)}>
              <UserPlus className="size-4" />
              Invite member
            </Button>
          ) : undefined
        }
        description={`Who can see and act inside ${organizationName ?? "this organization"}.`}
        title="Members"
      />

      {isAdmin && inviting && (
        <SettingsCard
          description="Invite by email, or by the wallet address they sign in with."
          title="Invite a member"
        >
          <InviteMemberForm onDone={() => setInviting(false)} />
        </SettingsCard>
      )}

      {members.loading ? (
        <StatTilesSkeleton tiles={3} />
      ) : (
        <MemberStats
          members={members.members}
          pendingCount={members.invitations.length}
          role={role}
        />
      )}

      <SettingsCard
        action={
          <Input
            className="h-8 w-48"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members"
            value={query}
          />
        }
        bodyClassName="p-2"
        title="Members of this organization"
      >
        {members.loading && <RowsSkeleton rows={4} />}
        {!members.loading && filtered.length === 0 && (
          <EmptyState>No members match that search.</EmptyState>
        )}
        {!members.loading && filtered.length > 0 && (
          <MembersTable
            canManage={isAdmin}
            currentMemberId={currentMemberId}
            members={filtered}
            onRemove={members.removeMember}
            onRoleChange={members.changeRole}
            updatingId={members.updatingId}
          />
        )}
      </SettingsCard>

      {isAdmin && (
        <InvitationsCard
          description="These people have been invited but have not joined yet."
          emptyLabel="No invitations are outstanding."
          loading={members.invitationsLoading}
          onCancel={(id) => {
            members.cancelInvitation(id).catch(() => undefined);
          }}
          rows={members.invitations.map((inv) => ({
            badge: inv.role,
            id: inv.id,
            label: inv.email,
          }))}
          title="Outstanding invitations"
        />
      )}
    </>
  );
}
