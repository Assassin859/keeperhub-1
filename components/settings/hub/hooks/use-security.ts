"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export type TotpStatus = {
  enabled: boolean;
  name: string | null;
  enrolledAt: string | null;
  hasBackupCodes: boolean;
};

export type SessionRow = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

export type SecurityState = {
  totp: TotpStatus | null;
  totpLoading: boolean;
  sessions: SessionRow[];
  sessionsLoading: boolean;
  reloadTotp: () => Promise<void>;
  reloadSessions: () => Promise<void>;
};

export function useSecurity(): SecurityState {
  const [totp, setTotp] = useState<TotpStatus | null>(null);
  const [totpLoading, setTotpLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const reloadTotp = useCallback(async (): Promise<void> => {
    setTotpLoading(true);
    try {
      const res = await fetch("/api/user/totp/status");
      if (res.ok) {
        setTotp((await res.json()) as TotpStatus);
      }
    } catch {
      toast.error("Could not load two-factor status");
    } finally {
      setTotpLoading(false);
    }
  }, []);

  const reloadSessions = useCallback(async (): Promise<void> => {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/user/sessions", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { sessions?: SessionRow[] };
        setSessions(data.sessions ?? []);
      }
    } catch {
      toast.error("Could not load your sessions");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    reloadTotp().catch(() => undefined);
    reloadSessions().catch(() => undefined);
  }, [reloadTotp, reloadSessions]);

  return {
    reloadSessions,
    reloadTotp,
    sessions,
    sessionsLoading,
    totp,
    totpLoading,
  };
}
