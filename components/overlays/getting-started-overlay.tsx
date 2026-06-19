"use client";

import {
  CheckCircle2,
  ChevronDown,
  Key,
  Plug,
  Wallet,
  Workflow,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ComponentType, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ApiKeysOverlay } from "./api-keys-overlay";
import { IntegrationsOverlay } from "./integrations-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";
import { WalletOverlay } from "./wallet-overlay";

type StepKey = "workflow" | "apiKey" | "integration" | "wallet";

type Step = {
  key: StepKey;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  cta: string;
};

type Progress = Record<StepKey, boolean>;

const EMPTY_PROGRESS: Progress = {
  workflow: false,
  apiKey: false,
  integration: false,
  wallet: false,
};

function hasItems(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["data", "items", "keys", "results"].some(
      (k) => Array.isArray(record[k]) && (record[k] as unknown[]).length > 0
    );
  }
  return false;
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// Marks a step done when the user already has the corresponding resource, so
// completed steps render with a green check.
function useGettingStartedProgress(): Progress {
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [workflows, keys, integrations, wallet] = await Promise.all([
        api.workflow.getAll().catch(() => []),
        fetchJson("/api/keys"),
        api.integration.getAll().catch(() => []),
        fetchJson("/api/user/wallet"),
      ]);
      if (cancelled) {
        return;
      }
      setProgress({
        workflow:
          Array.isArray(workflows) &&
          workflows.some((w) => w?.name !== "__current__"),
        apiKey: hasItems(keys),
        integration: Array.isArray(integrations) && integrations.length > 0,
        wallet: Boolean((wallet as { hasWallet?: boolean })?.hasWallet),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return progress;
}

/**
 * Quick platform intro for new users: a set of collapsible "dropdown" steps
 * that deep-link into the surfaces a new account should set up first. Reached
 * from the user menu and auto-opened once per account.
 */
export function GettingStartedOverlay({
  overlayId,
}: OverlayComponentProps): React.ReactElement {
  const { push, pop } = useOverlay();
  const router = useRouter();
  const progress = useGettingStartedProgress();

  const openBuilder = async (): Promise<void> => {
    try {
      const workflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: "",
        nodes: [],
        edges: [],
      });
      pop();
      router.push(`/workflows/${workflow.id}`);
    } catch {
      toast.error("Could not create a workflow.");
    }
  };

  const steps: (Step & { onAction: () => void })[] = [
    {
      key: "workflow",
      icon: Workflow,
      title: "Build your first workflow",
      description:
        "Start from the canvas: add a trigger, drop in actions, and run it.",
      cta: "Open the builder",
      onAction: () => {
        openBuilder();
      },
    },
    {
      key: "apiKey",
      icon: Key,
      title: "Create an API key",
      description:
        "Call your workflows and the platform API programmatically or from agents.",
      cta: "Manage API keys",
      onAction: () => push(ApiKeysOverlay),
    },
    {
      key: "integration",
      icon: Plug,
      title: "Connect an integration",
      description:
        "Link the services your workflows act on, like Discord or SendGrid.",
      cta: "Browse connections",
      onAction: () => push(IntegrationsOverlay),
    },
    {
      key: "wallet",
      icon: Wallet,
      title: "Set up your wallet",
      description:
        "Configure the organization wallet so workflows can act on-chain.",
      cta: "Open wallet",
      onAction: () => push(WalletOverlay),
    },
  ];

  return (
    <Overlay
      description="A few steps to get the most out of KeeperHub."
      overlayId={overlayId}
      title="Getting started"
    >
      <div className="flex flex-col gap-2">
        {steps.map((step, index) => {
          const done = progress[step.key];
          return (
            <Collapsible
              className={cn(
                "rounded-lg border",
                done && "border-keeperhub-green/40"
              )}
              defaultOpen={index === 0}
              key={step.title}
            >
              <CollapsibleTrigger
                className={cn(
                  "group flex w-full items-center gap-3 px-4 py-3 text-left",
                  "hover:bg-muted/50"
                )}
              >
                {done ? (
                  <CheckCircle2 className="size-4 text-keeperhub-green" />
                ) : (
                  <step.icon className="size-4 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    "flex-1 font-medium text-sm",
                    done && "text-muted-foreground line-through"
                  )}
                >
                  {step.title}
                </span>
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="px-4 pb-4">
                <p className="mb-3 text-muted-foreground text-sm">
                  {step.description}
                </p>
                <Button
                  className="w-full"
                  onClick={step.onAction}
                  size="sm"
                  type="button"
                >
                  {step.cta}
                </Button>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </Overlay>
  );
}
