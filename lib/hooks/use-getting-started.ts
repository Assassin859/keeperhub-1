"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authClient, useSession } from "@/lib/auth-client";
import type {
  BranchKey,
  SignalId,
} from "@/lib/onboarding/getting-started-config";

/**
 * Real-state progress + persisted UI state for the getting-started launcher
 * (KEEP-878). Each step in the config declares a named `SignalId`; this hook
 * resolves those signals from existing endpoints. Swapping a placeholder for a
 * real backend later means repointing one resolver here, not touching the
 * launcher or the config.
 */

export type LauncherState = "expanded" | "collapsed" | "dismissed";

type Persisted = {
  state: LauncherState;
  branch: BranchKey;
  done: string[];
};

const ALERT_INTEGRATION_TYPES = new Set(["discord", "telegram", "sendgrid"]);

function storageKey(userId: string | undefined): string {
  return `kh:getting-started:${userId ?? "anon"}`;
}

function readPersisted(userId: string | undefined): Persisted {
  const fallback: Persisted = { state: "collapsed", branch: "agent", done: [] };
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      state: parsed.state ?? fallback.state,
      branch: parsed.branch ?? fallback.branch,
      done: Array.isArray(parsed.done) ? parsed.done : [],
    };
  } catch {
    return fallback;
  }
}

function hasItems(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  const items = (value as { items?: unknown[] } | null)?.items;
  return Array.isArray(items) && items.length > 0;
}

function ranWorkflow(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((w) => (w as { name?: string })?.name !== "__current__")
  );
}

function alertsConnected(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((i) =>
      ALERT_INTEGRATION_TYPES.has((i as { type?: string })?.type ?? "")
    )
  );
}

const EMPTY_SIGNALS: Record<SignalId, boolean> = {
  walletReady: false,
  agentConnected: false,
  ranWorkflow: false,
  alertsConnected: false,
  walletFunded: false,
  always: true,
};

export type GettingStarted = {
  signals: Record<SignalId, boolean>;
  isComplete: (signal: SignalId, stepKey: string) => boolean;
  isLoading: boolean;
  refetch: () => void;
  state: LauncherState;
  setState: (next: LauncherState) => void;
  branch: BranchKey;
  setBranch: (next: BranchKey) => void;
  markStepDone: (stepKey: string) => void;
  isAuthenticated: boolean;
};

export function useGettingStarted(): GettingStarted {
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const userId = session?.user?.id;
  const activeOrgId = activeOrg?.id ?? null;
  const isAuthenticated = Boolean(session?.user);

  const [signals, setSignals] =
    useState<Record<SignalId, boolean>>(EMPTY_SIGNALS);
  const [isLoading, setIsLoading] = useState(true);
  const [refetchKey, setRefetchKey] = useState(0);
  const [persisted, setPersisted] = useState<Persisted>(() =>
    readPersisted(undefined)
  );

  // Re-hydrate persisted state once the user id is known (the key is per-user).
  useEffect(() => {
    setPersisted(readPersisted(userId));
  }, [userId]);

  const persist = useCallback(
    (next: Persisted) => {
      setPersisted(next);
      try {
        localStorage.setItem(storageKey(userId), JSON.stringify(next));
      } catch {
        // localStorage unavailable
      }
    },
    [userId]
  );

  const setState = useCallback(
    (next: LauncherState) => persist({ ...persisted, state: next }),
    [persist, persisted]
  );
  const setBranch = useCallback(
    (next: BranchKey) => persist({ ...persisted, branch: next }),
    [persist, persisted]
  );
  const markStepDone = useCallback(
    (stepKey: string) => {
      if (persisted.done.includes(stepKey)) {
        return;
      }
      persist({ ...persisted, done: [...persisted.done, stepKey] });
    },
    [persist, persisted]
  );

  const refetch = useCallback(() => setRefetchKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchKey intentionally re-runs the fetch
  useEffect(() => {
    if (!isAuthenticated) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      const [workflows, keys, integrations, wallet] = await Promise.allSettled([
        fetch("/api/workflows").then((r) => r.json()),
        fetch("/api/keys").then((r) => r.json()),
        fetch("/api/integrations").then((r) => r.json()),
        fetch("/api/user/wallet").then((r) => r.json()),
      ]);
      if (cancelled) {
        return;
      }
      const walletReady =
        wallet.status === "fulfilled" &&
        (wallet.value as { hasWallet?: boolean } | null)?.hasWallet === true;
      setSignals({
        walletReady,
        // placeholder: KEEP-878 follow-up - alias for a real agent-connection
        // signal; "has an API key" is the best proxy available today.
        agentConnected: keys.status === "fulfilled" && hasItems(keys.value),
        ranWorkflow:
          workflows.status === "fulfilled" && ranWorkflow(workflows.value),
        alertsConnected:
          integrations.status === "fulfilled" &&
          alertsConnected(integrations.value),
        // placeholder: KEEP-878 follow-up - real native-balance check; for now
        // this step completes via the local done-flag when the user funds.
        walletFunded: false,
        always: true,
      });
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, activeOrgId, refetchKey]);

  const doneSet = useMemo(() => new Set(persisted.done), [persisted.done]);

  const isComplete = useCallback(
    (signal: SignalId, stepKey: string): boolean =>
      signals[signal] || doneSet.has(stepKey),
    [signals, doneSet]
  );

  return {
    signals,
    isComplete,
    isLoading,
    refetch,
    state: persisted.state,
    setState,
    branch: persisted.branch,
    setBranch,
    markStepDone,
    isAuthenticated,
  };
}
