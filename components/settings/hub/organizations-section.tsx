"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/lib/hooks/use-organization";
import { CreateOrgForm } from "./create-org-form";
import { useOrganizationList } from "./hooks/use-organization-list";
import { useUserInvitations } from "./hooks/use-user-invitations";
import { InvitationsCard } from "./invitations-card";
import { OrganizationsTable } from "./organizations-table";
import { SectionHeader, SettingsCard } from "./section";
import { RowsSkeleton } from "./skeletons";

export function OrganizationsSection(): React.ReactElement {
  const { organization, switchOrganization } = useOrganization();
  const { organizations, memberCounts, loading, rename, create } =
    useOrganizationList();
  const { invitations, loading: invitationsLoading } = useUserInvitations();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <SectionHeader
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New organization
          </Button>
        }
        description={`Each organization has its own workflows, wallets, members and billing. You belong to ${organizations.length}.`}
        title="Organizations"
      />

      {createOpen && (
        <CreateOrgForm onCreate={create} onDone={() => setCreateOpen(false)} />
      )}

      <SettingsCard
        bodyClassName="p-2"
        description="Renaming applies to the organization you are working in. Switch to another one to manage it."
        title="Your organizations"
      >
        {loading ? (
          <RowsSkeleton rows={4} />
        ) : (
          <OrganizationsTable
            activeOrgId={organization?.id ?? null}
            memberCounts={memberCounts}
            onRename={rename}
            onSwitch={switchOrganization}
            organizations={organizations}
          />
        )}
      </SettingsCard>

      <InvitationsCard
        description="Invitations waiting on you to accept or decline."
        emptyLabel="No invitations are waiting on you."
        loading={invitationsLoading}
        reviewHref={(id) => `/accept-invite/${id}`}
        rows={invitations.map((inv) => ({
          id: inv.id,
          label: inv.organizationName ?? "An organization",
        }))}
        title="Invitations for you"
      />

    </>
  );
}
