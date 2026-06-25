"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import {
  type BranchKey,
  getBranches,
  type SignalId,
  type Step,
} from "@/lib/onboarding/getting-started-config";

/**
 * Persisted UI state + completion for the getting-started launcher (KEEP-878).
 *
 * Completion is hybrid and latched:
 *  - Outcome steps are detected from real state (`GET /api/onboarding/status`):
 *    a step turns green once the user has actually created an API key,
 *    connected an alert channel, or run a workflow. Opening the surface does
 *    not complete them.
 *  - Once a signal is first observed satisfied it is latched into persisted
 *    `done`, so the step stays complete even if the underlying workflow / key
 *    is later deleted (real state would otherwise flip it back to incomplete).
 *  - Informational steps ("open your wallet") have no measurable outcome and
 *    complete the first time the user opens them.
 *
 * `workflows` remembers the workflow created for an "ai-prompt" step so taking
 * that step again reuses it instead of spawning another Untitled Workflow.
 * All of this persists per user in localStorage.
 */

export type LauncherState = "expanded" | "collapsed" | "dismissed";

/** Signals satisfied by opening the surface (no server-measurable outcome). */
const CLICK_DRIVEN: ReadonlySet<SignalId> = new Set<SignalId>([
  "walletReady",
  "walletFunded",
]);

type OnboardingStatus = {
  hasApiKey: boolean;
  hasIntegration: boolean;
  /** Launcher-created workflows that have at least one execution. */
  executedWorkflowIds: string[];
};

type Persisted = {
  state: LauncherState;
  branch: BranchKey;
  done: string[];
  workflows: Record<string, string>;
};

function storageKey(userId: string | undefined): string {
  // v2: completion is now real-state + scoped-execution latched; drop any v1
  // state that latched steps from org-wide signals.
  return `kh:getting-started:v2:${userId ?? "anon"}`;
}

function readPersisted(userId: string | undefined): Persisted {
  const fallback: Persisted = {
    state: "collapsed",
    branch: "agent",
    done: [],
    workflows: {},
  };
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
      workflows:
        parsed.workflows && typeof parsed.workflows === "object"
          ? parsed.workflows
          : {},
    };
  } catch {
    return fallback;
  }
}

/** Whether any workflow this step created has been run. */
function stepWorkflowRan(
  step: Step,
  workflows: Record<string, string>,
  executedWorkflowIds: string[]
): boolean {
  const prefix = `${step.key}:`;
  for (const [key, workflowId] of Object.entries(workflows)) {
    if (key.startsWith(prefix) && executedWorkflowIds.includes(workflowId)) {
      return true;
    }
  }
  return false;
}

function resolveRealSignal(
  step: Step,
  status: OnboardingStatus | null,
  workflows: Record<string, string>
): boolean {
  if (!status) {
    return false;
  }
  switch (step.signal) {
    case "agentConnected":
      return status.hasApiKey;
    case "alertsConnected":
      return status.hasIntegration;
    case "ranWorkflow":
      return stepWorkflowRan(step, workflows, status.executedWorkflowIds);
    default:
      return false;
  }
}

/** Real-signal steps newly satisfied by `status` that are not yet latched. */
function newlyCompletedSteps(
  status: OnboardingStatus,
  done: string[],
  workflows: Record<string, string>
): string[] {
  const fresh: string[] = [];
  for (const branch of getBranches()) {
    for (const step of branch.steps) {
      if (CLICK_DRIVEN.has(step.signal) || step.signal === "always") {
        continue;
      }
      if (
        resolveRealSignal(step, status, workflows) &&
        !done.includes(step.key)
      ) {
        fresh.push(step.key);
      }
    }
  }
  return fresh;
}

export type GettingStarted = {
  isStepComplete: (step: Step) => boolean;
  state: LauncherState;
  setState: (next: LauncherState) => void;
  branch: BranchKey;
  setBranch: (next: BranchKey) => void;
  markStepActioned: (step: Step) => void;
  getStepWorkflowId: (key: string) => string | undefined;
  setStepWorkflowId: (key: string, workflowId: string) => void;
  refetch: () => void;
  isAuthenticated: boolean;
};

export function useGettingStarted(): GettingStarted {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const isAuthenticated = Boolean(session?.user);
  const [persisted, setPersisted] = useState<Persisted>(() =>
    readPersisted(undefined)
  );
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

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

  const workflowIds = Object.values(persisted.workflows).join(",");
  const fetchStatus = useCallback(() => {
    if (!isAuthenticated) {
      return;
    }
    const query = workflowIds
      ? `?workflowIds=${encodeURIComponent(workflowIds)}`
      : "";
    fetch(`/api/onboarding/status${query}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: OnboardingStatus | null) => {
        if (data) {
          setStatus(data);
        }
      })
      .catch(() => undefined);
  }, [isAuthenticated, workflowIds]);

  // Refresh real-state signals on mount and whenever the window regains focus
  // (e.g. returning from the builder after running a workflow).
  useEffect(() => {
    fetchStatus();
    window.addEventListener("focus", fetchStatus);
    return () => window.removeEventListener("focus", fetchStatus);
  }, [fetchStatus]);

  // While the checklist is open, poll so an outcome completed elsewhere (an
  // in-app overlay, or running the draft in the builder) is reflected without
  // a manual refresh.
  useEffect(() => {
    if (persisted.state !== "expanded") {
      return;
    }
    const id = setInterval(fetchStatus, 6000);
    return () => clearInterval(id);
  }, [persisted.state, fetchStatus]);

  // Latch satisfied real signals into `done` so completion survives the user
  // later deleting the workflow / key that produced it.
  useEffect(() => {
    if (!status) {
      return;
    }
    const fresh = newlyCompletedSteps(
      status,
      persisted.done,
      persisted.workflows
    );
    if (fresh.length > 0) {
      persist({ ...persisted, done: [...persisted.done, ...fresh] });
    }
  }, [status, persisted, persist]);

  const setState = useCallback(
    (next: LauncherState) => persist({ ...persisted, state: next }),
    [persist, persisted]
  );
  const setBranch = useCallback(
    (next: BranchKey) => persist({ ...persisted, branch: next }),
    [persist, persisted]
  );
  const markStepActioned = useCallback(
    (step: Step) => {
      // Outcome steps complete from real state, not from being opened.
      if (!CLICK_DRIVEN.has(step.signal) || persisted.done.includes(step.key)) {
        return;
      }
      persist({ ...persisted, done: [...persisted.done, step.key] });
    },
    [persist, persisted]
  );
  const isStepComplete = useCallback(
    (step: Step): boolean => {
      if (step.signal === "always" || persisted.done.includes(step.key)) {
        return true;
      }
      if (CLICK_DRIVEN.has(step.signal)) {
        return false;
      }
      return resolveRealSignal(step, status, persisted.workflows);
    },
    [persisted.done, persisted.workflows, status]
  );
  const getStepWorkflowId = useCallback(
    (key: string): string | undefined => persisted.workflows[key],
    [persisted.workflows]
  );
  const setStepWorkflowId = useCallback(
    (key: string, workflowId: string) =>
      persist({
        ...persisted,
        workflows: { ...persisted.workflows, [key]: workflowId },
      }),
    [persist, persisted]
  );

  return {
    isStepComplete,
    state: persisted.state,
    setState,
    branch: persisted.branch,
    setBranch,
    markStepActioned,
    getStepWorkflowId,
    setStepWorkflowId,
    refetch: fetchStatus,
    isAuthenticated,
  };
}
