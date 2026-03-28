"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  Info,
  KeyRound,
  Wallet,
  Workflow,
  X,
} from "lucide-react";
import { useRef } from "react";
import { AuthDialog } from "@/components/auth/dialog";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WalletOverlay } from "@/components/overlays/wallet-overlay";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession } from "@/lib/auth-client";
import { useOnboardingStatus } from "@/lib/hooks/use-onboarding-status";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { cn } from "@/lib/utils";

type StepConfig = {
  id: string;
  icon: typeof Workflow;
  title: string;
  extra?: React.ReactNode;
  requiresAuth: boolean;
  action: () => void;
};

type GettingStartedChecklistProps = {
  onCreateWorkflow?: () => void;
};

function ProgressBar({
  completed,
  total,
}: {
  completed: number;
  total: number;
}): React.ReactElement {
  const percentage = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="h-1 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
        style={{ width: `${Math.max(8, percentage)}%` }}
      />
    </div>
  );
}

type StepRowProps = {
  config: StepConfig;
  isComplete: boolean;
  onAction: () => void;
};

function StepRow({
  config,
  isComplete,
  onAction,
}: StepRowProps): React.ReactElement {
  const Icon = config.icon;

  const handleClick = (e: React.MouseEvent): void => {
    if ((e.target as Element).closest("[data-checklist-tooltip]")) {
      return;
    }
    onAction();
  };

  return (
    <button
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors select-none hover:bg-accent hover:text-accent-foreground",
        isComplete && "opacity-50"
      )}
      onClick={handleClick}
      type="button"
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          isComplete ? "text-emerald-500" : "text-muted-foreground"
        )}
      />
      <span className={cn(isComplete && "line-through")}>{config.title}</span>
      {config.extra ? (
        <span data-checklist-tooltip="">{config.extra}</span>
      ) : null}
      {isComplete && (
        <Check className="ml-auto size-3.5 shrink-0 text-emerald-500" />
      )}
    </button>
  );
}

function SkeletonRows(): React.ReactElement {
  return (
    <div className="space-y-0.5 p-1">
      {Array.from({ length: 3 }, (_, i) => (
        <div
          className="flex items-center gap-2 rounded-sm px-2 py-1.5"
          key={`skeleton-${String(i)}`}
        >
          <div className="size-4 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-28 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

const ICON_BTN =
  "rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

function DismissButton({
  onClick,
}: {
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      className={ICON_BTN}
      onClick={onClick}
      title="Dismiss"
      type="button"
    >
      <X className="size-4" />
    </button>
  );
}

export function GettingStartedChecklist({
  onCreateWorkflow,
}: GettingStartedChecklistProps): React.ReactElement | null {
  const {
    steps,
    isLoading,
    completedCount,
    guideState,
    collapse,
    expand,
    dismiss,
    refetch,
  } = useOnboardingStatus();
  const { open: openOverlay } = useOverlay();
  const { data: session } = useSession();
  const authTriggerRef = useRef<HTMLButtonElement>(null);

  const isAnonymous = isAnonymousUser(session?.user);

  const docsLink = (
    <p className="mt-1.5 text-center text-base tracking-wide text-muted-foreground/40">
      Need help?{" "}
      <a
        className="underline decoration-muted-foreground/20 underline-offset-2 transition-colors hover:text-muted-foreground hover:decoration-muted-foreground/40"
        href="https://docs.keeperhub.com/"
        rel="noopener noreferrer"
        target="_blank"
      >
        View docs
      </a>
    </p>
  );

  if (guideState === "dismissed") {
    return <div className="w-full min-w-[14rem] max-w-[16rem]">{docsLink}</div>;
  }

  const promptSignIn = (): void => {
    authTriggerRef.current?.click();
  };

  const stepConfigs: StepConfig[] = [
    {
      id: "create-workflow",
      icon: Workflow,
      title: "Create a Workflow",
      requiresAuth: false,
      action: () => onCreateWorkflow?.(),
    },
    {
      id: "generate-api-key",
      icon: KeyRound,
      title: "Generate API Key",
      requiresAuth: true,
      extra: (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="size-3.5 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="text-xs" side="top">
              Connect KeeperHub to your AI tools.{" "}
              <a
                className="underline"
                href="https://docs.keeperhub.com/ai-tools/mcp-server"
                rel="noopener noreferrer"
                target="_blank"
              >
                Learn more
              </a>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
      action: () =>
        openOverlay(ApiKeysOverlay, undefined, { onClose: refetch }),
    },
    {
      id: "create-wallet",
      icon: Wallet,
      title: "Create Wallet",
      requiresAuth: true,
      extra: (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="size-3.5 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-xs" side="top">
              Non-custodial wallet for signing blockchain transactions. Choose
              from multiple providers.{" "}
              <a
                className="underline"
                href="https://docs.keeperhub.com/wallet-management"
                rel="noopener noreferrer"
                target="_blank"
              >
                Learn more
              </a>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
      action: () => openOverlay(WalletOverlay, undefined, { onClose: refetch }),
    },
  ];

  if (guideState === "collapsed") {
    return (
      <div className="w-full min-w-[14rem] max-w-[16rem]">
        <div className="flex items-center rounded-md border bg-popover px-2 py-1.5 shadow-md">
          <span className="font-medium text-sm">Setup Guide</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {completedCount}/{steps.length}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              className={ICON_BTN}
              onClick={expand}
              title="Expand"
              type="button"
            >
              <ChevronDown className="size-4" />
            </button>
            <DismissButton onClick={dismiss} />
          </div>
        </div>
        {docsLink}
      </div>
    );
  }

  return (
    <div className="w-full min-w-[14rem] max-w-[16rem]">
      <div className="rounded-md border bg-popover shadow-md">
        <AuthDialog>
          <button className="hidden" ref={authTriggerRef} type="button" />
        </AuthDialog>

        <div className="flex items-center px-2 py-1.5">
          <span className="font-medium text-sm">Setup Guide</span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              className={ICON_BTN}
              onClick={collapse}
              title="Collapse"
              type="button"
            >
              <ChevronUp className="size-4" />
            </button>
            <DismissButton onClick={dismiss} />
          </div>
        </div>

        <div className="my-1 h-px bg-border" />

        <div className="px-1">
          {isLoading ? (
            <SkeletonRows />
          ) : (
            <div>
              {stepConfigs.map((config) => {
                const step = steps.find((s) => s.id === config.id);
                const isComplete = step?.complete ?? false;
                const action =
                  isAnonymous && config.requiresAuth
                    ? promptSignIn
                    : config.action;

                return (
                  <StepRow
                    config={config}
                    isComplete={isComplete}
                    key={config.id}
                    onAction={action}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="my-1 h-px bg-border" />

        <div className="px-2 py-1.5">
          {isLoading ? (
            <div className="h-1 w-full animate-pulse rounded-full bg-muted" />
          ) : (
            <ProgressBar completed={completedCount} total={steps.length} />
          )}
        </div>
      </div>
      {docsLink}
    </div>
  );
}
