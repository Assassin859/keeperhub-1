"use client";

import { useSetAtom } from "jotai";
import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo } from "react";
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
};

export function SuggestionPreviewDrawer({
  suggestion,
  open,
  onOpenChange,
  isAuthenticated,
}: SuggestionPreviewDrawerProps): React.ReactElement | null {
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setIsOwner = useSetAtom(isWorkflowOwnerAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const { openAuthPrompt } = useAuthPrompt();

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
    };
  }, [open, workflow, setNodes, setEdges, setIsOwner, setRightPanelWidth]);

  // Short-circuit AFTER hooks so the hook call order is stable.
  if (!suggestion) {
    return null;
  }

  const handleRunClick = (): void => {
    if (!isAuthenticated) {
      // T-53-06: gate-only; no privileged action in Phase 53.
      openAuthPrompt({ action: "scan-run" });
      return;
    }
    // Phase 54: actual run logic.
  };

  const handleScheduleClick = (): void => {
    if (!isAuthenticated) {
      // T-53-06: gate-only; no privileged action in Phase 53.
      openAuthPrompt({ action: "scan-schedule" });
      return;
    }
    // Phase 54: save-on-schedule logic.
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
                    aria-readonly={true}
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

          {/* CTAs — clicking while unauthenticated opens AuthDialog via
              useAuthPrompt, without closing the drawer or clearing selection
              (SC#4 / SCANUI-04). No create/save/run API call in Phase 53. */}
          <div className="mt-6 flex gap-3">
            <Button
              className="flex-1"
              onClick={handleRunClick}
              variant="default"
            >
              Run
            </Button>
            <Button
              className="flex-1"
              onClick={handleScheduleClick}
              variant="outline"
            >
              Save on schedule
            </Button>
          </div>

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
