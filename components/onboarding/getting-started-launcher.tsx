"use client";

import { useAtom, useSetAtom } from "jotai";
import { Check, ChevronDown, Sparkles, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { IntegrationsOverlay } from "@/components/overlays/integrations-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WalletOverlay } from "@/components/overlays/wallet-overlay";
import { Button } from "@/components/ui/button";
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
  type StepAction,
} from "@/lib/onboarding/getting-started-config";
import { cn } from "@/lib/utils";
import {
  editorTourRequestedAtom,
  gettingStartedOpenAtom,
  pendingAiPromptAtom,
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
  className,
}: {
  done: number;
  total: number;
  className?: string;
}): React.ReactElement {
  const r = 8;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  return (
    <svg
      aria-hidden="true"
      className={cn("size-5 -rotate-90", className)}
      viewBox="0 0 20 20"
    >
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

function StepRow({
  step,
  complete,
  onAction,
  onChip,
}: {
  step: Step;
  complete: boolean;
  onAction: (action: StepAction, stepKey: string) => void;
  onChip: (prompt: string) => void;
}): React.ReactElement {
  return (
    <div
      className="flex gap-3 py-2"
      data-complete={complete}
      data-testid={`gs-step-${step.key}`}
    >
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
      <div className="flex-1 space-y-1.5">
        <div
          className={cn(
            "font-medium text-sm",
            complete && "text-muted-foreground line-through",
            step.muted && "text-muted-foreground line-through"
          )}
        >
          {step.title}
        </div>
        <p className="text-muted-foreground text-xs">{step.description}</p>
        {step.chips && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {step.chips.map((chip) => (
              <button
                className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:bg-muted"
                key={chip.id}
                onClick={() => onChip(chip.prompt)}
                type="button"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {step.action && !complete && (
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => step.action && onAction(step.action, step.key)}
            size="sm"
            variant="outline"
          >
            {step.ctaLabel ?? "Open"}
          </Button>
        )}
      </div>
    </div>
  );
}

function ExpandedCard({
  gs,
  onAction,
  onChip,
  onTakeTour,
}: {
  gs: GettingStarted;
  onAction: (action: StepAction, stepKey: string) => void;
  onChip: (prompt: string) => void;
  onTakeTour: () => void;
}): React.ReactElement {
  const branches = getBranches();
  const active = branches.find((b) => b.key === gs.branch) ?? branches[0];
  const total = active.steps.length;
  const done = active.steps.filter((s) =>
    gs.isComplete(s.signal, s.key)
  ).length;

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

      <div className="max-h-[60vh] overflow-y-auto px-4 py-2">
        {active.steps.map((step) => (
          <StepRow
            complete={gs.isComplete(step.signal, step.key)}
            key={step.key}
            onAction={onAction}
            onChip={onChip}
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

  // The user-menu "Getting started" entry flips this to reopen the launcher.
  useEffect(() => {
    if (forceOpen) {
      gs.setState("expanded");
      setForceOpen(false);
    }
  }, [forceOpen, gs, setForceOpen]);

  const isBuilder = pathname?.startsWith("/workflows/") ?? false;

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
  const runAiPrompt = async (prompt: string): Promise<void> => {
    try {
      const workflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: prompt,
        nodes: [],
        edges: [],
      });
      if (AI_ENABLED) {
        setPendingAiPrompt(prompt);
      }
      router.push(`/workflows/${workflow.id}`);
    } catch {
      toast.error("Could not start a workflow.");
    }
  };

  const onAction = (action: StepAction, stepKey: string): void => {
    if (action.kind === "deeplink") {
      // Funding has no auto-detectable signal yet; mark it done locally.
      if (action.target === "wallet-fund") {
        gs.markStepDone(stepKey);
      }
      openDeepLink(action.target);
    } else if (action.kind === "ai-prompt") {
      runAiPrompt(action.prompt);
    }
  };

  // Position bottom-right; on the builder route shift to bottom-left so it never
  // overlaps the right-side Properties panel.
  const anchor = isBuilder ? "left-4" : "right-4";

  return (
    <div className={cn("fixed bottom-4 z-50", anchor)}>
      {gs.state === "expanded" ? (
        <ExpandedCard
          gs={gs}
          onAction={onAction}
          onChip={runAiPrompt}
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
  return branch.steps.filter((s) => gs.isComplete(s.signal, s.key)).length;
}
