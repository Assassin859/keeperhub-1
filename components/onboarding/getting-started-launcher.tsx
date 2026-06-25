"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, Info, Sparkles, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { IntegrationsOverlay } from "@/components/overlays/integrations-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WalletOverlay } from "@/components/overlays/wallet-overlay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import {
  type GettingStarted,
  useGettingStarted,
} from "@/lib/hooks/use-getting-started";
import {
  type BranchKey,
  type DeepLinkTarget,
  getBranches,
  type Step,
} from "@/lib/onboarding/getting-started-config";
import { cn } from "@/lib/utils";
import {
  editorTourRequestedAtom,
  gettingStartedOpenAtom,
  isSidebarCollapsedAtom,
  pendingAiPromptAtom,
  rightPanelWidthAtom,
} from "@/lib/workflow/store";

const SUPPRESSED_PATHS = new Set([
  "/verify-mfa",
  "/enroll-mfa",
  "/enforce-mfa",
  "/verify-ip",
]);

// AI workflow generation is gated by this flag and is off in prod + staging.
const AI_ENABLED = process.env.NEXT_PUBLIC_AI_PROMPT_ENABLED === "true";

function ProgressRing({
  done,
  total,
}: {
  done: number;
  total: number;
}): React.ReactElement {
  const r = 8;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  return (
    <svg aria-hidden="true" className="-rotate-90 size-5" viewBox="0 0 20 20">
      <circle
        className="text-muted-foreground/30"
        cx="10"
        cy="10"
        fill="none"
        r={r}
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle
        className="text-emerald-500 transition-[stroke-dashoffset] duration-500"
        cx="10"
        cy="10"
        fill="none"
        r={r}
        stroke="currentColor"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function StepCheck({ complete }: { complete: boolean }): React.ReactElement {
  return (
    <span
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
        complete
          ? "border-emerald-500 bg-emerald-500 text-white"
          : "border-muted-foreground/40"
      )}
    >
      {complete && <Check aria-hidden="true" className="size-3" />}
    </span>
  );
}

function StepRow({
  step,
  complete,
  onAction,
  onChip,
  onInfo,
}: {
  step: Step;
  complete: boolean;
  onAction: (step: Step) => void;
  onChip: (step: Step, prompt: string) => void;
  onInfo: (step: Step) => void;
}): React.ReactElement {
  const clickable = Boolean(step.action) && !step.muted;
  const body = (
    <div className="flex-1 space-y-1.5 text-left">
      <div
        className={cn(
          "font-medium text-sm",
          step.muted && "text-muted-foreground"
        )}
      >
        {step.title}
      </div>
      <p className="text-muted-foreground text-xs">{step.description}</p>
    </div>
  );

  return (
    <div
      className="rounded-md transition-colors hover:bg-muted/40"
      data-complete={complete}
      data-testid={`gs-step-${step.key}`}
    >
      <div className="flex items-start gap-2 p-2">
        {clickable && step.action ? (
          <button
            className="flex flex-1 items-start gap-3"
            onClick={() => onAction(step)}
            type="button"
          >
            <StepCheck complete={complete} />
            {body}
          </button>
        ) : (
          <div className="flex flex-1 items-start gap-3">
            <StepCheck complete={complete} />
            {body}
          </div>
        )}
        <button
          aria-label={`More info about ${step.title}`}
          className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onInfo(step)}
          title="More info"
          type="button"
        >
          <Info aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {step.chips && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-2 pl-9">
          {step.chips.map((chip) => (
            <button
              className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:bg-muted"
              key={chip.id}
              onClick={() => onChip(step, chip.prompt)}
              type="button"
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StepInfoDialog({
  step,
  creditLabel,
  onAction,
  onClose,
}: {
  step: Step | null;
  creditLabel: string;
  onAction: (step: Step) => void;
  onClose: () => void;
}): React.ReactElement {
  const action = step?.action;
  const fill = (text: string): string =>
    text.replaceAll("{credit}", creditLabel);
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={step !== null}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{step?.title}</DialogTitle>
          <DialogDescription>
            {step ? fill(step.info.summary) : ""}
          </DialogDescription>
        </DialogHeader>
        {step ? (
          <div className="flex flex-col gap-4">
            {step.info.sections.map((section) => (
              <div className="flex flex-col gap-1.5" key={section.heading}>
                <p className="font-medium text-foreground text-sm">
                  {section.heading}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {section.points.map((point) => (
                    <li
                      className="flex gap-2 text-muted-foreground text-sm"
                      key={point}
                    >
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
                      />
                      <span>{fill(point)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
        {step && action && step.actionLabel ? (
          <DialogFooter>
            <Button
              onClick={() => {
                onAction(step);
                onClose();
              }}
              type="button"
            >
              {step.actionLabel}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ExpandedCard({
  gs,
  creditLabel,
  onAction,
  onChip,
  onTakeTour,
}: {
  gs: GettingStarted;
  creditLabel: string;
  onAction: (step: Step) => void;
  onChip: (step: Step, prompt: string) => void;
  onTakeTour: () => void;
}): React.ReactElement {
  const [infoStep, setInfoStep] = useState<Step | null>(null);
  const branches = getBranches();
  const active = branches.find((b) => b.key === gs.branch) ?? branches[0];
  const total = active.steps.length;
  const done = active.steps.filter((s) => gs.isStepComplete(s)).length;

  return (
    <div
      className="w-80 overflow-hidden rounded-xl border bg-popover shadow-xl"
      data-testid="gs-launcher-card"
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">Get started</span>
          <span
            className="text-muted-foreground text-xs"
            data-done={done}
            data-testid="gs-progress"
            data-total={total}
          >
            {done} of {total}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            aria-label="Collapse"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => gs.setState("collapsed")}
            type="button"
          >
            <ChevronDown aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-label="Dismiss"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => gs.setState("dismissed")}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      <Tabs
        onValueChange={(v) => gs.setBranch(v as BranchKey)}
        value={active.key}
      >
        <TabsList className="grid w-full grid-cols-3 rounded-none border-b bg-transparent p-0">
          {branches.map((b) => (
            <TabsTrigger
              className="rounded-none text-xs data-[state=active]:bg-muted/50"
              key={b.key}
              value={b.key}
            >
              {b.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="max-h-[60vh] space-y-1 overflow-y-auto px-2 py-2">
        {active.steps.map((step) => (
          <StepRow
            complete={gs.isStepComplete(step)}
            key={step.key}
            onAction={onAction}
            onChip={onChip}
            onInfo={setInfoStep}
            step={step}
          />
        ))}
      </div>

      <div className="flex items-center justify-between border-t px-4 py-2 text-muted-foreground text-xs">
        <span>Reopen anytime from your account menu.</span>
        <button
          className="font-medium text-foreground underline-offset-2 hover:underline"
          onClick={onTakeTour}
          type="button"
        >
          Take a tour
        </button>
      </div>

      <StepInfoDialog
        creditLabel={creditLabel}
        onAction={onAction}
        onClose={() => setInfoStep(null)}
        step={infoStep}
      />
    </div>
  );
}

export function GettingStartedLauncher(): React.ReactElement | null {
  const gs = useGettingStarted();
  const pathname = usePathname();
  const router = useRouter();
  const { open } = useOverlay();
  const [, setPendingAiPrompt] = useAtom(pendingAiPromptAtom);
  const [forceOpen, setForceOpen] = useAtom(gettingStartedOpenAtom);
  const requestTour = useSetAtom(editorTourRequestedAtom);
  // Read-only triggers: re-measure the panel whenever its open/width state changes.
  const isSidebarCollapsed = useAtomValue(isSidebarCollapsedAtom);
  const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
  const [creditLabel, setCreditLabel] = useState("$1");
  const [panelOpen, setPanelOpen] = useState(false);

  // The user-menu "Getting started" entry flips this to reopen the launcher.
  useEffect(() => {
    if (forceOpen) {
      gs.setState("expanded");
      setForceOpen(false);
    }
  }, [forceOpen, gs, setForceOpen]);

  // Fetch the env-driven free gas sponsorship amount for the wallet info copy.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/gas-sponsorship")
      .then((r) => r.json())
      .then((data: { label?: string }) => {
        if (!cancelled && data?.label) {
          setCreditLabel(data.label);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Detect whether the builder's right Properties panel is actually on screen by
  // measuring its live DOM rect (when collapsed it slides off the right edge).
  // The pill then anchors to the opposite bottom corner so it never overlaps the
  // panel at any viewport width. The atoms/pathname below are read only to
  // re-trigger this measurement, never written.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname and the panel atoms are intentional re-measure triggers, not values read in the effect body
  useEffect(() => {
    const measure = (): void => {
      const rect = document
        .querySelector('[data-testid="properties-panel"]')
        ?.getBoundingClientRect();
      setPanelOpen(
        Boolean(rect && rect.width > 0 && rect.left < window.innerWidth - 8)
      );
    };
    measure();
    // Re-measure after the panel's 300ms open/close slide settles.
    const timer = setTimeout(measure, 320);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, [pathname, isSidebarCollapsed, rightPanelWidth]);

  if (!gs.isAuthenticated || SUPPRESSED_PATHS.has(pathname ?? "")) {
    return null;
  }
  if (gs.state === "dismissed") {
    return null;
  }

  const openDeepLink = (target: DeepLinkTarget): void => {
    if (target === "api-keys") {
      open(ApiKeysOverlay);
    } else if (target === "integrations") {
      open(IntegrationsOverlay);
    } else {
      open(WalletOverlay);
    }
  };

  // AI generation is gated by NEXT_PUBLIC_AI_PROMPT_ENABLED and is OFF in prod +
  // staging. When enabled, seed the prompt so the builder auto-generates; when
  // not, just open a fresh builder with the prompt kept as the description so
  // the user still has the context of what they set out to build.
  //
  // The workflow is created once per (step, prompt) and remembered: taking the
  // step again reopens that same draft instead of spawning another Untitled
  // Workflow. If the user deleted it, a fresh one is created.
  const runAiPrompt = async (step: Step, prompt: string): Promise<void> => {
    const key = `${step.key}:${prompt}`;
    const existingId = gs.getStepWorkflowId(key);
    if (existingId) {
      try {
        await api.workflow.getById(existingId);
        router.push(`/workflows/${existingId}`);
        return;
      } catch {
        // The remembered workflow was deleted; fall through to create a new one.
      }
    }
    try {
      // Seed a starting Manual trigger + action (the builder's own "Start
      // building" shape) so the draft opens with a usable canvas instead of a
      // blank one with an empty properties panel.
      const stamp = Date.now();
      const triggerId = `trigger-${stamp}`;
      const actionId = `action-${stamp}`;
      const workflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: prompt,
        nodes: [
          {
            id: triggerId,
            type: "trigger" as const,
            position: { x: 400, y: 200 },
            data: {
              label: "",
              type: "trigger" as const,
              config: { triggerType: "Manual" },
              status: "idle" as const,
            },
          },
          {
            id: actionId,
            type: "action" as const,
            position: { x: 672, y: 200 },
            data: {
              label: "",
              type: "action" as const,
              config: {},
              status: "idle" as const,
            },
          },
        ],
        edges: [
          {
            id: `edge-${stamp}`,
            source: triggerId,
            target: actionId,
            type: "animated",
          },
        ],
      });
      gs.setStepWorkflowId(key, workflow.id);
      if (AI_ENABLED) {
        setPendingAiPrompt(prompt);
      }
      router.push(`/workflows/${workflow.id}`);
    } catch {
      toast.error("Could not start a workflow.");
    }
  };

  // Taking a step's action opens the relevant surface. Outcome steps only
  // complete once the real state changes (refetched here and on focus); the
  // informational "open your wallet" steps complete on open via markStepActioned.
  const onAction = (step: Step): void => {
    gs.markStepActioned(step);
    const { action } = step;
    if (action?.kind === "deeplink") {
      openDeepLink(action.target);
    } else if (action?.kind === "ai-prompt") {
      runAiPrompt(step, action.prompt);
    }
    gs.refetch();
  };

  const onChip = (step: Step, prompt: string): void => {
    gs.markStepActioned(step);
    runAiPrompt(step, prompt);
  };

  // Panel open -> bottom-left (clears it on any width); closed -> bottom-right.
  return (
    <div
      className={cn("fixed bottom-4 z-50", panelOpen ? "left-4" : "right-4")}
    >
      {gs.state === "expanded" ? (
        <ExpandedCard
          creditLabel={creditLabel}
          gs={gs}
          onAction={onAction}
          onChip={onChip}
          onTakeTour={() => requestTour(true)}
        />
      ) : (
        <button
          className="flex items-center gap-2 rounded-full border bg-popover py-2 pr-4 pl-3 shadow-lg transition-colors hover:bg-muted"
          data-testid="gs-launcher-pill"
          onClick={() => gs.setState("expanded")}
          type="button"
        >
          <ProgressRing done={launcherDone(gs)} total={launcherTotal(gs)} />
          <Sparkles aria-hidden="true" className="size-3.5 text-primary" />
          <span className="font-medium text-sm">
            Getting started {launcherDone(gs)}/{launcherTotal(gs)}
          </span>
        </button>
      )}
    </div>
  );
}

function launcherTotal(gs: GettingStarted): number {
  const branch = getBranches().find((b) => b.key === gs.branch);
  return branch?.steps.length ?? 0;
}

function launcherDone(gs: GettingStarted): number {
  const branch = getBranches().find((b) => b.key === gs.branch);
  if (!branch) {
    return 0;
  }
  return branch.steps.filter((s) => gs.isStepComplete(s)).length;
}
