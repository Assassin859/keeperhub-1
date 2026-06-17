"use client";

import { useSetAtom } from "jotai";
import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuthPrompt } from "@/components/auth/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { WorkflowCanvas } from "@/components/workflow/workflow-canvas";
import { buildWorkflow } from "@/lib/scan/factory";
import { persistSuggestion } from "@/lib/scan/persist-suggestion";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import {
  edgesAtom,
  isWorkflowOwnerAtom,
  nodesAtom,
  rightPanelWidthAtom,
} from "@/lib/workflow/store";

type SuggestionPreviewDrawerProps = {
  suggestion: SuggestionDescriptor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAuthenticated: boolean;
  /** Scanned EVM address from the page — used to build the redirectTo URL for
   *  the anon sign-in round-trip (FUNNEL-02). */
  address: string;
};

export function SuggestionPreviewDrawer({
  suggestion,
  open,
  onOpenChange,
  isAuthenticated,
  address,
}: SuggestionPreviewDrawerProps): React.ReactElement | null {
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setIsOwner = useSetAtom(isWorkflowOwnerAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const { openAuthPrompt } = useAuthPrompt();
  const router = useRouter();
  const [needsWallet, setNeedsWallet] = useState<boolean>(false);
  const [isPersisting, setIsPersisting] = useState<boolean>(false);
  const [isProvisioning, setIsProvisioning] = useState<boolean>(false);

  // Build the prefilled workflow client-side. Factory has no server-only
  // import (confirmed in RESEARCH). Guard with try/catch: buildWorkflow throws
  // on invalid template refs or MaxUint256 approvals.
  const workflow = useMemo(() => {
    if (!suggestion) {
      return null;
    }
    try {
      return buildWorkflow(suggestion);
    } catch {
      return null;
    }
  }, [suggestion]);

  // Hydrate global Jotai workflow atoms when the drawer opens.
  // CRITICAL: cleanup MUST reset atoms on close so the homepage canvas
  // is not polluted when the user navigates away (T-53-08 / Pitfall 2).
  // Also resets the provision gate (needsWallet) so it does not carry over
  // to a different suggestion opened in a subsequent drawer session.
  useEffect(() => {
    if (open && workflow) {
      setNodes(workflow.nodes);
      setEdges(workflow.edges);
      // isWorkflowOwnerAtom=false → WorkflowToolbar shows read-only mode;
      // NodeConfigPanel gates all write controls behind isOwner (Pitfall 3).
      setIsOwner(false);
      // Reset any stale panel width from a previous /workflows/* visit
      // (Pitfall 3: rightPanelWidth would narrow the canvas otherwise).
      setRightPanelWidth(null);
    }

    return () => {
      // Runs on close (open changes) and on unmount.
      // currentWorkflowIdAtom is deliberately NOT set here or anywhere in
      // this component — keeping it null suppresses WorkflowToolbar and
      // prevents autosave (T-53-08).
      setNodes([]);
      setEdges([]);
      setIsOwner(true);
      setRightPanelWidth(null);
      setNeedsWallet(false);
    };
  }, [open, workflow, setNodes, setEdges, setIsOwner, setRightPanelWidth]);

  // Short-circuit AFTER hooks so the hook call order is stable.
  if (!suggestion) {
    return null;
  }

  const handleCta = async (mode: "run" | "schedule"): Promise<void> => {
    // Guard: suggestion is always non-null here (early return above),
    // but the closure type is SuggestionDescriptor | null.
    if (!suggestion) {
      return;
    }

    if (!isAuthenticated) {
      // Anon path (T-54-30): set the pending_scan cookie, then open the
      // auth prompt. No create/PATCH/execute while unauthenticated — the
      // server APIs 401 anon regardless (defence-in-depth).
      try {
        await fetch("/api/auth/scan-intent", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intent: JSON.stringify({ ...suggestion, mode }),
          }),
        });
      } catch {
        // Non-fatal: if the cookie write fails the round-trip won't auto-
        // resume, but the user can still sign in and proceed manually.
      }
      openAuthPrompt({
        action: mode === "schedule" ? "scan-schedule" : "scan-run",
        redirectTo: `/scan?address=${encodeURIComponent(address)}`,
      });
      return;
    }

    // Write gate (FUNNEL-05, forward-compat): all v1.13 real suggestions are
    // read-only; this branch is exercised only by SYNTHETIC_WRITE_DESCRIPTOR.
    if (suggestion.readOrWrite === "write") {
      try {
        const res = await fetch("/api/scan/wallet-check", {
          method: "GET",
          credentials: "same-origin",
        });
        if (!res.ok) {
          toast.error("Could not verify wallet status. Please try again.");
          return;
        }
        const data = (await res.json()) as { hasWallet: boolean };
        if (!data.hasWallet) {
          // Surface the provision CTA; do NOT persist (T-54-33).
          setNeedsWallet(true);
          return;
        }
      } catch {
        toast.error("Could not verify wallet status. Please try again.");
        return;
      }
    }

    // Authenticated + read suggestion (or write + wallet present): persist inline.
    setIsPersisting(true);
    try {
      const { id } = await persistSuggestion(suggestion, mode);
      toast.success("Workflow saved!");
      router.push(`/workflows/${id}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save workflow";
      toast.error(message);
    } finally {
      setIsPersisting(false);
    }
  };

  const handleRunClick = (): void => {
    handleCta("run").catch(() => {
      // Errors are handled inside handleCta.
    });
  };

  const handleScheduleClick = (): void => {
    handleCta("schedule").catch(() => {
      // Errors are handled inside handleCta.
    });
  };

  const doProvision = async (): Promise<void> => {
    setIsProvisioning(true);
    try {
      const res = await fetch("/api/agentic-wallet/provision", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.ok) {
        toast.success("Wallet set up! You can now run this workflow.");
        setNeedsWallet(false);
      } else {
        toast.error("Failed to set up wallet. Please try again.");
      }
    } catch {
      toast.error("Failed to set up wallet. Please try again.");
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleProvisionClick = (): void => {
    doProvision().catch(() => {
      // Errors are handled inside doProvision.
    });
  };

  const confirmEntries = Object.entries(suggestion.confirmInputs);

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="sm:max-w-xl w-full overflow-y-auto" side="right">
        <SheetHeader className="border-b border-border/20">
          <SheetTitle className="text-base font-semibold text-foreground">
            {suggestion.name}
          </SheetTitle>
          <SheetDescription className="mt-1 text-sm text-muted-foreground">
            {suggestion.description}
          </SheetDescription>
        </SheetHeader>

        <div className="p-4">
          {/* Canvas preview area — WorkflowCanvas fills the container at
              100% height. [data-testid="workflow-canvas"] is on the canvas
              root div inside WorkflowCanvas (verified in source). */}
          <section
            aria-label="Workflow preview"
            className="h-80 w-full rounded-lg border border-border/20 bg-[var(--color-hub-overlay)] overflow-hidden"
          >
            <WorkflowCanvas />
          </section>

          {/* Workflow parameters — read-only prefilled values. Values rendered
              via React value prop only (T-53-07: no dangerouslySetInnerHTML). */}
          {confirmEntries.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Workflow parameters
              </h3>
              {confirmEntries.map(([key, value]) => (
                <div className="mb-3" key={key}>
                  <label
                    className="mb-1 block text-xs text-muted-foreground"
                    htmlFor={`param-${key}`}
                  >
                    {key}
                  </label>
                  <Input
                    className="cursor-default bg-muted font-mono text-sm"
                    id={`param-${key}`}
                    readOnly
                    tabIndex={-1}
                    value={value}
                  />
                </div>
              ))}
            </div>
          )}

          {/* CTAs — see FUNNEL-02/03/04/05 for the full branching logic.
              needsWallet replaces the normal CTA pair with a provision prompt
              (FUNNEL-05, write-type suggestion only, forward-compat). */}
          {needsWallet ? (
            <div className="mt-6">
              <p className="mb-3 text-sm text-muted-foreground">
                This workflow requires a connected wallet. Set one up to
                continue.
              </p>
              <Button
                className="w-full"
                disabled={isProvisioning}
                onClick={handleProvisionClick}
                variant="default"
              >
                Set up Wallet
              </Button>
            </div>
          ) : (
            <div className="mt-6 flex gap-3">
              <Button
                className="flex-1"
                disabled={isPersisting}
                onClick={handleRunClick}
                variant="default"
              >
                Run
              </Button>
              <Button
                className="flex-1"
                disabled={isPersisting}
                onClick={handleScheduleClick}
                variant="outline"
              >
                Save on schedule
              </Button>
            </div>
          )}

          {/* Risk note — rendered as JSX text (T-53-07). */}
          <div className="mt-4 flex items-start gap-1.5">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60"
            />
            <p className="text-xs leading-relaxed text-muted-foreground/80">
              {suggestion.riskNote}
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
