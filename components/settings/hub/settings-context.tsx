"use client";

import { useParams } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useActiveMember,
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import type { OrgRole } from "@/lib/organization/role-label";

type SettingsContextValue = {
  organizationId: string | null;
  organizationName: string | null;
  role: OrgRole | undefined;
  /** True until the active membership role has actually resolved. */
  roleLoading: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  /**
   * Bumps on every active-organization change and on refreshAll(). Every
   * settings hook keys its fetch on it, so switching orgs reloads all of the
   * hub at once instead of each section discovering the change on its own.
   */
  revision: number;
  refreshAll: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const params = useParams();
  const {
    organization,
    isLoading: orgLoading,
    switchOrganization: setActiveOrganization,
  } = useOrganization();
  const {
    role: memberRole,
    isOwner,
    isAdmin,
    isLoading: memberLoading,
  } = useActiveMember();
  const { organizations, isLoading: orgsLoading } = useOrganizations();
  const [revision, setRevision] = useState(0);

  // The URL is the source of truth for org-scoped sections, so a shared link
  // opens the organization it was written for rather than whichever one the
  // session happens to be on.
  const routeOrgId =
    typeof params.orgId === "string" ? params.orgId : null;
  const organizationId = routeOrgId ?? organization?.id ?? null;

  // useOrganization rebuilds switchOrganization on every render, so it is read
  // through a ref: keeping it in the dependency list would re-run this on each
  // render and thrash setActive.
  const switchRef = useRef(setActiveOrganization);
  switchRef.current = setActiveOrganization;
  const activeOrgId = organization?.id;

  useEffect(() => {
    if (routeOrgId && activeOrgId && routeOrgId !== activeOrgId) {
      switchRef.current(routeOrgId);
    }
  }, [routeOrgId, activeOrgId]);



  // useActiveMember reads the role off the active-organization payload, which
  // does not always carry the members array. /api/organizations returns a role
  // per organization, so fall back to that rather than render a blank badge.
  const listedRole = organizations.find((o) => o.id === organizationId)?.role;
  const role = (memberRole ?? listedRole) as OrgRole | undefined;
  const roleLoading = !role && (memberLoading || orgsLoading || orgLoading);

  useEffect(() => {
    setRevision((n) => n + 1);
  }, [organizationId]);

  const refreshAll = useCallback((): void => {
    setRevision((n) => n + 1);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      isAdmin,
      isLoading: orgLoading || memberLoading,
      isOwner,
      organizationId,
      organizationName: organization?.name ?? null,
      refreshAll,
      revision,
      role,
      roleLoading,
    }),
    [
      isAdmin,
      isOwner,
      memberLoading,
      roleLoading,
      organization?.name,
      organizationId,
      orgLoading,
      refreshAll,
      revision,
      role,
    ]
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettingsContext(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) {
    throw new Error("useSettingsContext must be used inside SettingsProvider");
  }
  return value;
}
