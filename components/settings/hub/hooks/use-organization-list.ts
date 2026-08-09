"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import {
  type OrganizationWithRole,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import { useSettingsContext } from "../settings-context";

export type OrganizationListState = {
  organizations: OrganizationWithRole[];
  /** Member count per organization id; absent while the count is in flight. */
  memberCounts: Record<string, number>;
  loading: boolean;
  countsLoading: boolean;
  rename: (organizationId: string, name: string) => Promise<boolean>;
  create: (name: string, slug: string) => Promise<boolean>;
};

async function countMembers(organizationId: string): Promise<number> {
  try {
    const result = await authClient.organization.listMembers({
      query: { organizationId },
    });
    const data = result.data as { members?: unknown[] } | unknown[] | null;
    const list = Array.isArray(data) ? data : (data?.members ?? []);
    return list.length;
  } catch {
    return 0;
  }
}

export function useOrganizationList(): OrganizationListState {
  const { revision, refreshAll } = useSettingsContext();
  const { organizations, isLoading, refetch } = useOrganizations();
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [countsLoading, setCountsLoading] = useState(true);

  const ids = organizations.map((org) => org.id).join(",");

  // `revision` is in the deps so an org switch reloads the counts alongside
  // every other settings section instead of going stale.
  useEffect(() => {
    if (!ids) {
      setCountsLoading(false);
      return;
    }
    let active = true;
    setCountsLoading(true);
    Promise.all(
      ids.split(",").map(async (id) => [id, await countMembers(id)] as const)
    )
      .then((entries) => {
        if (active) {
          setMemberCounts(Object.fromEntries(entries));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setCountsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [ids, revision]);

  useEffect(() => {
    refetch().catch(() => undefined);
  }, [refetch]);

  const rename = useCallback(
    async (organizationId: string, name: string): Promise<boolean> => {
      try {
        await api.organization.updateName(organizationId, { name });
        toast.success("Organization renamed");
        await refetch();
        refreshAll();
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to rename"
        );
        return false;
      }
    },
    [refetch, refreshAll]
  );

  const create = useCallback(
    async (name: string, slug: string): Promise<boolean> => {
      try {
        const { data, error } = await authClient.organization.create({
          name,
          slug,
        });
        if (error) {
          toast.error(error.message || "Failed to create organization");
          return false;
        }
        const orgId = (data as { id: string } | null)?.id;
        if (!orgId) {
          return false;
        }
        await authClient.organization.setActive({ organizationId: orgId });
        toast.success(`Organization "${name}" created`);
        await refetch();
        refreshAll();
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "An error occurred"
        );
        return false;
      }
    },
    [refetch, refreshAll]
  );

  return {
    countsLoading,
    create,
    loading: isLoading,
    memberCounts,
    organizations,
    rename,
  };
}
