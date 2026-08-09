"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useSettingsContext } from "../settings-context";

export type OrgMember = {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  user: { name: string; email: string; image?: string };
};

export type SentInvitation = {
  id: string;
  email: string;
  role: string;
  status: string;
};

export type OrgMembersState = {
  members: OrgMember[];
  invitations: SentInvitation[];
  loading: boolean;
  invitationsLoading: boolean;
  /** Member id whose role change is in flight. */
  updatingId: string | null;
  refetch: () => Promise<void>;
  cancelInvitation: (invitationId: string) => Promise<void>;
  changeRole: (memberId: string, role: string) => Promise<void>;
  removeMember: (member: OrgMember) => Promise<void>;
};

async function fetchMembers(organizationId: string): Promise<OrgMember[]> {
  const result = await authClient.organization.listMembers({
    query: { organizationId },
  });
  const data = result.data as { members?: OrgMember[] } | OrgMember[] | null;
  const list = Array.isArray(data) ? data : (data?.members ?? []);
  return list.filter(Boolean);
}

async function fetchInvitations(
  organizationId: string
): Promise<SentInvitation[]> {
  const result = await authClient.organization.listInvitations({
    query: { organizationId },
  });
  const list = Array.isArray(result.data) ? result.data : [];
  return (list as SentInvitation[]).filter((inv) => inv.status === "pending");
}

export function useOrgMembers(): OrgMembersState {
  const { organizationId, isAdmin, revision } = useSettingsContext();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<SentInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    if (!organizationId) {
      setLoading(false);
      setInvitationsLoading(false);
      return;
    }
    setLoading(true);
    try {
      setMembers(await fetchMembers(organizationId));
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
    }

    if (!isAdmin) {
      setInvitations([]);
      setInvitationsLoading(false);
      return;
    }
    setInvitationsLoading(true);
    try {
      setInvitations(await fetchInvitations(organizationId));
    } catch {
      setInvitations([]);
    } finally {
      setInvitationsLoading(false);
    }
  }, [organizationId, isAdmin]);

  useEffect(() => {
    refetch().catch(() => undefined);
  }, [refetch, revision]);

  const cancelInvitation = useCallback(
    async (invitationId: string): Promise<void> => {
      try {
        await authClient.organization.cancelInvitation({ invitationId });
        toast.success("Invitation cancelled");
        await refetch();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to cancel invitation"
        );
      }
    },
    [refetch]
  );

  const changeRole = useCallback(
    async (memberId: string, role: string): Promise<void> => {
      setUpdatingId(memberId);
      try {
        await authClient.organization.updateMemberRole({ memberId, role });
        await refetch();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update role"
        );
      } finally {
        setUpdatingId(null);
      }
    },
    [refetch]
  );

  const removeMember = useCallback(
    async (member: OrgMember): Promise<void> => {
      try {
        await authClient.organization.removeMember({
          memberIdOrEmail: member.user.email,
        });
        toast.success(`Removed ${member.user.name}`);
        await refetch();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to remove member"
        );
      }
    },
    [refetch]
  );

  return {
    cancelInvitation,
    changeRole,
    removeMember,
    updatingId,
    invitations,
    invitationsLoading,
    loading,
    members,
    refetch,
  };
}
