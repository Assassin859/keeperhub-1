"use client";

import { Plus, UserPlus } from "lucide-react";
import { useState } from "react";
import { InviteMemberForm } from "@/components/organization/invite-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/auth-client";
import { useOrganizations } from "@/lib/hooks/use-organization";
import { CreateOrgForm } from "./create-org-form";
import { useOrganizationList } from "./hooks/use-organization-list";
import { useOrgMembers } from "./hooks/use-org-members";
import { useUserInvitations } from "./hooks/use-user-invitations";
import { InvitationsCard } from "./invitations-card";
import { MemberStats } from "./member-stats";
import { MembersTable } from "./members/members-table";
import { OrgDetailsCard } from "./organization/org-details-card";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { RowsSkeleton, StatTilesSkeleton } from "./skeletons";

export function OrganizationSection(): React.ReactElement {
  const { organizationId, isAdmin, isOwner, role } = useSettingsContext();
  const { organizations } = useOrganizations();
  const { rename, create } = useOrganizationList();
  const { data: session } = useSession();
  const members = useOrgMembers();
  const invitations = useUserInvitations();
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [creating, setCreating] = useState(false);

  const org = organizations.find((o) => o.id === organizationId);
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
          <Button onClick={() => setCreating((v) => !v)} variant="outline">
            <Plus className="size-4" />
            New organization
          </Button>
        }
        description="This organization and the people in it. Everything here applies only to the organization selected in the header."
        title="Organization"
      />

      {creating && (
        <CreateOrgForm onCreate={create} onDone={() => setCreating(false)} />
      )}

      <OrgDetailsCard
        canRename={isOwner}
        name={org?.name ?? ""}
        onRename={(next) =>
          organizationId ? rename(organizationId, next) : Promise.resolve(false)
        }
        role={role}
        slug={org?.slug ?? ""}
      />

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
          <div className="flex items-center gap-2">
            <Input
              className="h-8 w-44"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              value={query}
            />
            {isAdmin && (
              <Button onClick={() => setInviting((v) => !v)} size="sm">
                <UserPlus className="size-3.5" />
                Invite
              </Button>
            )}
          </div>
        }
        bodyClassName="p-2"
        title="Members"
      >
        {inviting && isAdmin && (
          <div className="m-2 rounded-lg border p-4">
            <InviteMemberForm
              onDone={() => setInviting(false)}
              onInvited={() => {
                members.refetch().catch(() => undefined);
              }}
            />
          </div>
        )}
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
          description="Invited but not joined yet. Resending issues a new link and invalidates the old one."
          emptyLabel="No invitations are outstanding."
          loading={members.invitationsLoading}
          onCancel={(id) => {
            members.cancelInvitation(id).catch(() => undefined);
          }}
          onResend={(id) => {
            const invitation = members.invitations.find((i) => i.id === id);
            if (invitation) {
              members.resendInvitation(invitation).catch(() => undefined);
            }
          }}
          rows={members.invitations.map((inv) => ({
            badge: inv.role,
            expired: inv.expiresAt
              ? new Date(inv.expiresAt) < new Date()
              : false,
            id: inv.id,
            label: inv.email,
          }))}
          title="Outstanding invitations"
        />
      )}

      <InvitationsCard
        description="Invitations waiting on you to accept or decline."
        emptyLabel="No invitations are waiting on you."
        loading={invitations.loading}
        reviewHref={(id) => `/accept-invite/${id}`}
        rows={invitations.invitations.map((inv) => ({
          id: inv.id,
          label: inv.organizationName ?? "An organization",
        }))}
        title="Invitations for you"
      />
    </>
  );
}
