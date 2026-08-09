"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useSettingsContext } from "../settings-context";

export type UserInvitation = {
  id: string;
  email: string;
  status: string;
  organizationName?: string;
};

/** Invitations addressed to the signed-in user, across every organization. */
export function useUserInvitations(): {
  invitations: UserInvitation[];
  loading: boolean;
} {
  const { revision } = useSettingsContext();
  const [invitations, setInvitations] = useState<UserInvitation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    authClient.organization
      .listUserInvitations()
      .then((result) => {
        if (!active) {
          return;
        }
        const list = Array.isArray(result.data) ? result.data : [];
        setInvitations(
          (list as UserInvitation[]).filter((inv) => inv.status === "pending")
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [revision]);

  return { invitations, loading };
}
