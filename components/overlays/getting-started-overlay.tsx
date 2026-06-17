"use client";

import { ChevronDown, Key, Plug, Wallet, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ComponentType } from "react";
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

type Step = {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  cta: string;
};

/**
 * Quick platform intro for new users: a set of collapsible "dropdown" steps
 * that deep-link into the surfaces a new account should set up first. Reached
 * from the user menu and auto-opened once per account.
 */
export function GettingStartedOverlay({
  overlayId,
}: OverlayComponentProps): React.ReactElement {
  const { open, pop } = useOverlay();
  const router = useRouter();

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
      icon: Key,
      title: "Create an API key",
      description:
        "Call your workflows and the platform API programmatically or from agents.",
      cta: "Manage API keys",
      onAction: () => open(ApiKeysOverlay),
    },
    {
      icon: Plug,
      title: "Connect an integration",
      description:
        "Link the services your workflows act on, like Discord or SendGrid.",
      cta: "Browse connections",
      onAction: () => open(IntegrationsOverlay),
    },
    {
      icon: Wallet,
      title: "Set up your wallet",
      description:
        "Configure the organization wallet so workflows can act on-chain.",
      cta: "Open wallet",
      onAction: () => open(WalletOverlay),
    },
  ];

  return (
    <Overlay
      description="A few steps to get the most out of KeeperHub."
      overlayId={overlayId}
      title="Getting started"
    >
      <div className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <Collapsible
            className="rounded-lg border"
            defaultOpen={index === 0}
            key={step.title}
          >
            <CollapsibleTrigger
              className={cn(
                "group flex w-full items-center gap-3 px-4 py-3 text-left",
                "hover:bg-muted/50"
              )}
            >
              <step.icon className="size-4 text-muted-foreground" />
              <span className="flex-1 font-medium text-sm">{step.title}</span>
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
        ))}
      </div>
    </Overlay>
  );
}
