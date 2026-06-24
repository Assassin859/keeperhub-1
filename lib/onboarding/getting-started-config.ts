import { Bot, LineChart, Sprout } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Config for the first-run "Get started" launcher (KEEP-878). Three goal
 * branches, each an ordered path to first value. The launcher UI renders purely
 * from this config + the named completion signals resolved in
 * `lib/hooks/use-getting-started.ts`.
 *
 * Placeholder seams (see the plan / KEEP-878 follow-ups) are isolated here so
 * the real backend swaps in without touching the launcher:
 *  - `getMonitorTargets` / `getYieldStrategies` return chip lists; today static,
 *    later fed by a monitor-template registry / wallet-holdings scanner behind
 *    the same signature.
 *  - step completion uses a named `SignalId` resolved by the hook; e.g.
 *    `agentConnected` currently aliases "API key exists" and can be repointed at
 *    a real agent-connection endpoint without changing any step here.
 *  - `StepAction` is a discriminated union; chips ship as `ai-prompt` now and a
 *    future curated workflow becomes `{ kind: "template", id }` with no UI churn.
 */

export type BranchKey = "agent" | "monitor" | "yield";

/** Named real-state completion signals resolved in use-getting-started.ts. */
export type SignalId =
  | "walletReady"
  | "agentConnected"
  | "ranWorkflow"
  | "alertsConnected"
  | "walletFunded"
  // `always` is a pre-checked / not-a-task step (e.g. "wallet not needed").
  | "always";

/** What a step's primary action does. */
export type StepAction =
  // Seed a preset prompt into the AI builder and open a fresh workflow.
  | { kind: "ai-prompt"; prompt: string }
  // Open an in-app overlay (api-keys, integrations, wallet) by id.
  | { kind: "deeplink"; target: DeepLinkTarget }
  // placeholder: KEEP-878 follow-up - a curated template id once the registry
  // exists; not emitted yet, here so the union is stable for swap-in.
  | { kind: "template"; id: string };

export type DeepLinkTarget =
  | "api-keys"
  | "integrations"
  | "wallet"
  | "wallet-fund";

export type Chip = {
  id: string;
  label: string;
  /** Preset prompt the chip seeds into the AI generator. */
  prompt: string;
};

export type Step = {
  key: string;
  title: string;
  description: string;
  /** Completion signal; `always` renders pre-checked. */
  signal: SignalId;
  /** Primary CTA; omitted for `always` confirmation steps. */
  action?: StepAction;
  ctaLabel?: string;
  /** Optional inline chips (each seeds the AI generator). */
  chips?: Chip[];
  /** Render struck-through / muted (e.g. "wallet not needed"). */
  muted?: boolean;
};

export type Branch = {
  key: BranchKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
  steps: Step[];
};

type ChipContext = {
  /** Reserved for the future holdings scanner. Unused while static. */
  walletAddress?: string | null;
};

// placeholder: KEEP-878 follow-up - monitor event-trigger registry. Static
// today; later returns targets from the template/registry backend.
export function getMonitorTargets(_ctx: ChipContext = {}): Chip[] {
  return [
    {
      id: "aave-health",
      label: "Aave health factor",
      prompt:
        "Monitor my Aave v3 health factor every hour and alert me when it drops below 1.5.",
    },
    {
      id: "whale-withdrawal",
      label: "Large withdrawal",
      prompt:
        "Watch for large withdrawals from my tracked address and alert me when one exceeds a threshold.",
    },
    {
      id: "governance",
      label: "Governance",
      prompt:
        "Notify me when a new governance proposal is created for the protocols I follow.",
    },
  ];
}

// placeholder: KEEP-878 follow-up - wallet-holdings scanner + strategy catalog.
// Static curated list today; later returns strategies derived from holdings.
export function getYieldStrategies(_ctx: ChipContext = {}): Chip[] {
  return [
    {
      id: "sky-staking",
      label: "SKY staking optimizer",
      prompt:
        "Stake my SKY into the sUSDS vault and compound the rewards weekly.",
    },
    {
      id: "steth-wrap",
      label: "stETH wrap",
      prompt: "Wrap my stETH into wstETH and hold it for yield.",
    },
    {
      id: "usds-savings",
      label: "USDS savings",
      prompt:
        "Deposit my USDS into the sUSDS savings vault and rebalance monthly.",
    },
  ];
}

export function getBranches(ctx: ChipContext = {}): Branch[] {
  return [
    {
      key: "agent",
      label: "Connect an agent",
      icon: Bot,
      steps: [
        {
          key: "wallet-ready",
          title: "Wallet ready",
          description: "Non-custodial Turnkey - gas-sponsored - Sepolia ready.",
          signal: "walletReady",
          action: { kind: "deeplink", target: "wallet-fund" },
          ctaLabel: "Fund / Get testnet ETH",
        },
        {
          key: "connect-agent",
          title: "Connect your agent",
          description:
            "Add KeeperHub to Claude or Cursor, then run `list my workflows` to confirm.",
          signal: "agentConnected",
          action: { kind: "deeplink", target: "api-keys" },
          ctaLabel: "Get your key",
        },
        {
          key: "run-workflow",
          title: "Run your first workflow",
          description: "Pick a template or describe it in a sentence.",
          signal: "ranWorkflow",
          action: {
            kind: "ai-prompt",
            prompt:
              "Create a simple workflow that runs on a schedule and sends me a Discord message.",
          },
          ctaLabel: "Describe it",
        },
      ],
    },
    {
      key: "monitor",
      label: "Monitor",
      icon: LineChart,
      steps: [
        {
          key: "pick-watch",
          title: "Pick what to watch",
          description: "Health factor, large withdrawals, governance.",
          signal: "ranWorkflow",
          chips: getMonitorTargets(ctx),
        },
        {
          key: "connect-alerts",
          title: "Connect alerts",
          description: "Discord, Telegram, or email.",
          signal: "alertsConnected",
          action: { kind: "deeplink", target: "integrations" },
          ctaLabel: "Connect alerts",
        },
        {
          key: "monitor-no-wallet",
          title: "Wallet - not needed",
          description: "Monitoring is read-only - gas-free.",
          signal: "always",
          muted: true,
        },
      ],
    },
    {
      key: "yield",
      label: "Yield",
      icon: Sprout,
      steps: [
        {
          key: "fund-wallet",
          title: "Fund your wallet",
          description:
            "Turnkey wallet created - add funds for write actions, or use Sepolia.",
          signal: "walletFunded",
          action: { kind: "deeplink", target: "wallet-fund" },
          ctaLabel: "Fund wallet",
        },
        {
          key: "pick-strategy",
          title: "Pick a yield strategy",
          description: "Based on what your wallet holds.",
          signal: "ranWorkflow",
          chips: getYieldStrategies(ctx),
        },
        {
          key: "run-automate",
          title: "Run & automate",
          description: "Compound weekly, rebalance on threshold.",
          signal: "ranWorkflow",
          action: {
            kind: "ai-prompt",
            prompt:
              "Automate my yield strategy: compound weekly and rebalance when it drifts past a threshold.",
          },
          ctaLabel: "Automate it",
        },
      ],
    },
  ];
}
