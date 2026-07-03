"use client";

import {
  Activity,
  BarChart3,
  Bookmark,
  Check,
  ChevronDown,
  Copy,
  DollarSign,
  Globe,
  History,
  Info,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { KeeperHubLogo } from "@/components/icons/keeperhub-logo";
import { Badge } from "@/components/ui/badge";
import {
  BleedStage,
  CenteredStage,
  PreviewFrame,
  PreviewNavRow,
  SkeletonBar,
} from "@/components/welcome/preview/primitives";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Hub", icon: Globe },
  { label: "Workflows", icon: Workflow },
  { label: "Analytics", icon: BarChart3 },
  { label: "Earnings", icon: DollarSign },
  { label: "Address Book", icon: Bookmark },
  { label: "Activity", icon: Activity },
] as const;

// --- Molecules -------------------------------------------------------------

/** Top bar with the organization switcher highlighted and tracking the name. */
function OrgTopBar({ name }: { name: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 border-border border-b px-5 py-4">
      <KeeperHubLogo className="size-6" />
      <div className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 ring-2 ring-primary">
        <Users className="size-4 text-muted-foreground" />
        <span className="max-w-[220px] truncate font-medium text-sm">
          {name}
        </span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </div>
    </div>
  );
}

/** App sidebar: primary nav at the top, community links pinned to the bottom. */
function OrgSidebar(): React.ReactElement {
  return (
    <div className="flex w-48 flex-col border-border border-r p-3">
      <div className="flex flex-col gap-1">
        <PreviewNavRow active icon={Plus} label="New Workflow" />
        {NAV_ITEMS.map((item) => (
          <PreviewNavRow icon={item.icon} key={item.label} label={item.label} />
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-1 border-border border-t pt-2">
        <PreviewNavRow icon={DiscordIcon} label="Join Discord" />
        <PreviewNavRow icon={Info} label="Documentation" />
      </div>
    </div>
  );
}

/** Placeholder main content area beside the sidebar. */
function OrgMain(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <SkeletonBar className="h-6 w-40 bg-muted-foreground/15" />
      <div className="flex gap-3">
        <SkeletonBar className="h-16 flex-1 rounded-lg bg-muted/40" />
        <SkeletonBar className="h-16 flex-1 rounded-lg bg-muted/40" />
        <SkeletonBar className="h-16 flex-1 rounded-lg bg-muted/40" />
      </div>
      <div className="flex-1 rounded-lg border border-border bg-card p-4">
        <SkeletonBar className="mb-3 h-4 w-28 bg-muted-foreground/15" />
        <div className="flex flex-col gap-3">
          <SkeletonBar className="h-3 w-full" />
          <SkeletonBar className="h-3 w-5/6" />
          <SkeletonBar className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}

/** A members row matching the Manage Organizations modal: email, role, 2FA. */
function MemberRow({
  label,
  roleLabel,
  twoFactor = false,
  invited = false,
}: {
  label: string;
  roleLabel: string;
  twoFactor?: boolean;
  invited?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate font-medium text-sm",
            invited && "text-muted-foreground"
          )}
        >
          {label}
        </p>
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs">
            {roleLabel}
            {invited ? " - invited" : ""}
          </p>
          {twoFactor ? (
            <Badge
              className="gap-1 border-keeperhub-green/30 bg-keeperhub-green/10 text-keeperhub-green"
              variant="outline"
            >
              <ShieldCheck />
              2FA on
            </Badge>
          ) : null}
        </div>
      </div>
      <History className="size-4 shrink-0 text-muted-foreground" />
    </div>
  );
}

// --- Organisms -------------------------------------------------------------

/** Step 1 preview: app chrome with the org switcher highlighted. */
export function OrgPreview({ name }: { name: string }): React.ReactElement {
  const display = name.trim() || "Your Organization";
  return (
    <BleedStage>
      <PreviewFrame className="bg-background">
        <OrgTopBar name={display} />
        <div className="flex h-[560px]">
          <OrgSidebar />
          <OrgMain />
        </div>
      </PreviewFrame>
    </BleedStage>
  );
}

/** Step 2 preview: the org's members panel, reflecting the teammates invited. */
export type InviteEntry = { label: string; role: string };

export function InvitePreview({
  orgName,
  ownerLabel,
  invitees,
}: {
  orgName: string;
  ownerLabel: string;
  invitees: InviteEntry[];
}): React.ReactElement {
  const rows =
    invitees.length > 0
      ? invitees
      : [{ label: "colleague@example.com", role: "member" }];
  return (
    <CenteredStage className="w-[500px]">
      <PreviewFrame className="bg-card p-4">
        <div className="mb-4 flex items-center gap-2">
          <h3 className="min-w-0 truncate font-semibold text-base">
            {orgName}
          </h3>
          <Badge
            className="shrink-0 gap-1 border-keeperhub-green/30 bg-keeperhub-green/10 text-keeperhub-green"
            variant="outline"
          >
            Active
          </Badge>
        </div>
        <p className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Members
        </p>
        <div className="space-y-2">
          <MemberRow label={ownerLabel} roleLabel="owner" twoFactor />
          {rows.map((entry) => (
            <MemberRow
              invited
              key={entry.label}
              label={entry.label}
              roleLabel={entry.role}
            />
          ))}
        </div>
      </PreviewFrame>
    </CenteredStage>
  );
}

/** Step 3 preview: the API Keys modal where the agent key lives. */
const EXAMPLE_PROMPTS = [
  "Create a yield monitor for my stETH position and alert me on Discord when rewards are ready to redeem",
  "Notify me on Telegram whenever a withdrawal over 10 ETH leaves my treasury wallet",
  "Watch my Aave v3 health factor hourly and message me if it drops below 1.5",
  "Alert me when a new governance proposal opens for the protocols I follow",
  "Send a daily summary of my LP fees and rebalance the position when it drifts over 5%",
];

export function ConnectAgentPreview(): React.ReactElement {
  const [copied, setCopied] = useState<string | null>(null);

  const copyPrompt = (prompt: string): void => {
    navigator.clipboard
      .writeText(prompt)
      .then(() => {
        setCopied(prompt);
        setTimeout(
          () => setCopied((current) => (current === prompt ? null : current)),
          1500
        );
      })
      .catch(() => undefined);
  };

  return (
    <CenteredStage className="w-[440px]">
      <PreviewFrame className="bg-card">
        <div className="flex items-center gap-2 border-border border-b px-5 py-4">
          <Sparkles className="size-4 text-primary" />
          <h3 className="font-semibold text-sm">Try these in your agent</h3>
        </div>
        <div className="flex flex-col gap-2 p-5">
          {EXAMPLE_PROMPTS.map((prompt) => {
            const isCopied = copied === prompt;
            return (
              <button
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-left text-foreground text-sm transition-colors hover:bg-muted/60",
                  isCopied
                    ? "border-keeperhub-green"
                    : "border-border hover:border-keeperhub-green"
                )}
                key={prompt}
                onClick={() => copyPrompt(prompt)}
                type="button"
              >
                {isCopied ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-keeperhub-green" />
                ) : (
                  <Copy className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span>{prompt}</span>
              </button>
            );
          })}
        </div>
      </PreviewFrame>
    </CenteredStage>
  );
}
