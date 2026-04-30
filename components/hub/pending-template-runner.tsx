"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";

const SESSION_KEY_PREFIX = "pending_template:";
const IDEMPOTENCY_TTL_MS = 30_000; // 30s (43-CONTEXT.md HUB-05)

type StoredFlag = { at: number };

type IntentResponse = { workflowId: string | null };

function readSessionFlag(workflowId: string): StoredFlag | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.sessionStorage.getItem(SESSION_KEY_PREFIX + workflowId);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredFlag;
    if (typeof parsed?.at === "number") {
      return parsed;
    }
  } catch {
    // Malformed entry — treat as absent.
  }
  return null;
}

function writeSessionFlag(workflowId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const value: StoredFlag = { at: Date.now() };
  try {
    window.sessionStorage.setItem(
      SESSION_KEY_PREFIX + workflowId,
      JSON.stringify(value)
    );
  } catch {
    // Quota / privacy mode — best-effort, OK to skip.
  }
}

function isFlagFresh(flag: StoredFlag): boolean {
  return Date.now() - flag.at < IDEMPOTENCY_TTL_MS;
}

/**
 * Mounts in app/layout.tsx (broadest scope). On first mount per OAuth
 * round-trip, fetches GET /api/auth/template-intent to read the
 * pending_template cookie (which the server clears atomically), then —
 * if a workflowId comes back — runs router.refresh() before firing
 * api.workflow.duplicate exactly once. SessionStorage with a 30s TTL
 * guards against re-mount re-fires within the same tab.
 *
 * 43-CONTEXT.md HUB-05; UI-SPEC §4 Post-OAuth auto-trigger.
 */
export function PendingTemplateRunner(): null {
  const router = useRouter();
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) {
      return;
    }
    hasRun.current = true;

    let cancelled = false;

    const run = async (): Promise<void> => {
      let workflowId: string | null = null;
      try {
        const res = await fetch("/api/auth/template-intent", {
          method: "GET",
          credentials: "same-origin",
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as IntentResponse;
        workflowId = data.workflowId;
      } catch (err) {
        console.error("[PendingTemplate] read intent failed:", err);
        return;
      }

      if (!workflowId || cancelled) {
        return;
      }

      const existing = readSessionFlag(workflowId);
      if (existing && isFlagFresh(existing)) {
        return;
      }

      router.refresh();

      try {
        const duplicated = await api.workflow.duplicate(workflowId);
        writeSessionFlag(workflowId);
        toast.success("Template ready in your workflows");
        router.push(`/workflows/${duplicated.id}`);
      } catch (err) {
        console.error("[PendingTemplate] duplicate failed:", err);
        const message =
          err instanceof Error ? err.message : "Failed to use template";
        toast.error(message);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
