"use client";

import {
  Activity,
  ArrowUp,
  AudioLines,
  BarChart3,
  Bookmark,
  Boxes,
  Check,
  ChevronDown,
  Copy,
  DollarSign,
  Globe,
  History,
  Info,
  Loader2,
  Mic,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import { motion } from "motion/react";
import {
  type ComponentType,
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  ClaudeCodeIcon,
  ClaudeIcon,
  EveIcon,
  GeminiIcon,
  GooseIcon,
  HermesIcon,
  OpenAIIcon,
  OpenClawIcon,
} from "@/components/icons/agent-icons";
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

// Step 3 preview: a mocked, branded agent session that reflects the selected
// left-panel tab. CLI clients get a terminal window; chat clients get a chat
// window. The run re-animates whenever the agent or the prompt changes.
type InterfaceKind = "cli" | "chat";

type FrameworkMeta = {
  name: string;
  Icon: ComponentType<{ className?: string }>;
  kind: InterfaceKind;
  launch: string;
  model: string;
};

const FALLBACK_META: FrameworkMeta = {
  name: "Claude Code",
  Icon: ClaudeCodeIcon,
  kind: "cli",
  launch: "claude",
  model: "Opus 4.8",
};

const FRAMEWORK_META: Record<string, FrameworkMeta> = {
  "claude-code": FALLBACK_META,
  "claude-desktop": {
    name: "Claude Desktop",
    Icon: ClaudeIcon,
    kind: "chat",
    launch: "claude",
    model: "Opus 4.8",
  },
  openclaw: {
    name: "OpenClaw",
    Icon: OpenClawIcon,
    kind: "cli",
    launch: "openclaw",
    model: "GPT-5",
  },
  codex: {
    name: "Codex",
    Icon: OpenAIIcon,
    kind: "cli",
    launch: "codex",
    model: "GPT-5-Codex",
  },
  "gemini-cli": {
    name: "Gemini CLI",
    Icon: GeminiIcon,
    kind: "cli",
    launch: "gemini",
    model: "Gemini 3 Pro",
  },
  goose: {
    name: "Goose",
    Icon: GooseIcon,
    kind: "cli",
    launch: "goose",
    model: "GPT-5",
  },
  other: {
    name: "Your agent",
    Icon: Boxes,
    kind: "chat",
    launch: "agent",
    model: "Auto",
  },
  "claude-plugin": {
    name: "Claude Code",
    Icon: ClaudeCodeIcon,
    kind: "cli",
    launch: "claude",
    model: "Opus 4.8",
  },
  hermes: {
    name: "Hermes",
    Icon: HermesIcon,
    kind: "cli",
    launch: "hermes",
    model: "Hermes 4",
  },
  eve: {
    name: "Eve",
    Icon: EveIcon,
    kind: "cli",
    launch: "eve",
    model: "GPT-5",
  },
};

// A turn: the user asks, the agent thinks, states its intent, calls a tool,
// then confirms. Conversations are multi-turn (create, then refine).
type Turn = {
  user: string;
  intent: string;
  tool: string;
  confirm: string;
};

type Conversation = { turns: Turn[]; result: string };

const STETH_CONVO: Conversation = {
  turns: [
    {
      user: "Create a workflow that monitors my stETH rewards and alerts me on Discord when they are ready to redeem",
      intent:
        "I'll create a workflow that checks your stETH rewards hourly and posts to Discord when they are ready.",
      tool: "create_workflow",
      confirm: "Done. Your stETH yield monitor is live.",
    },
    {
      user: "Now update it to skip the alert when gas is above 40 gwei",
      intent:
        "I'll add a gas guard so it holds the alert when gas is above 40 gwei.",
      tool: "update_workflow",
      confirm: "Updated. It now waits for gas to fall below 40 gwei.",
    },
  ],
  result: "stETH yield monitor",
};

const CONVERSATIONS: Conversation[] = [
  STETH_CONVO,
  {
    turns: [
      {
        user: "Create a workflow that pings me on Telegram when a withdrawal over 10 ETH leaves my treasury",
        intent:
          "I'll set up a watch on your treasury that messages you on Telegram for any withdrawal above 10 ETH.",
        tool: "create_workflow",
        confirm: "Done. Your large withdrawal alert is live.",
      },
      {
        user: "Now raise the threshold to 25 ETH and add an email copy",
        intent:
          "I'll raise the threshold to 25 ETH and add an email copy to each alert.",
        tool: "update_workflow",
        confirm: "Updated. The threshold is 25 ETH and email copies are on.",
      },
    ],
    result: "Large withdrawal alert",
  },
  {
    turns: [
      {
        user: "Create a workflow that watches my Aave v3 health factor and messages me if it drops below 1.5",
        intent:
          "I'll monitor your Aave v3 health factor and message you when it drops below 1.5.",
        tool: "create_workflow",
        confirm: "Done. Your Aave health guard is live.",
      },
      {
        user: "Now also add a repay suggestion when it drops below 1.3",
        intent:
          "I'll include a repay suggestion in the alert when it falls below 1.3.",
        tool: "update_workflow",
        confirm:
          "Updated. Below 1.3 the alert now includes a repay suggestion.",
      },
    ],
    result: "Aave health guard",
  },
];

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

// Reveals a sentence word-by-word so the assistant text types out over `dur`
// frames instead of appearing all at once.
const wordSlice = (text: string, elapsed: number, dur: number): string => {
  const words = text.split(" ");
  const shown = clamp(
    Math.ceil((elapsed / dur) * words.length),
    0,
    words.length
  );
  return words.slice(0, shown).join(" ");
};

type ToolState = "idle" | "running" | "done";

type TurnState = {
  key: string;
  user: string;
  fullUser: string;
  typingUser: boolean;
  sent: boolean;
  showAssistant: boolean;
  thinking: boolean;
  showIntent: boolean;
  intent: string;
  intentTyping: boolean;
  toolState: ToolState;
  tool: string;
  showConfirm: boolean;
  confirm: string;
  confirmTyping: boolean;
};

// Live state of the chat composer for the turn currently being typed. Null when
// no turn is composing (assistant is responding or the run is idle).
type ComposeState = {
  text: string;
  full: string;
  typing: boolean;
  canSend: boolean;
};

// Drives the whole multi-turn conversation on a single frame clock: each turn
// types the user line, thinks, states intent, runs its tool, then confirms.
// Keyed by the parent so a new agent/prompt remounts and restarts it.
function useConversation(convo: Conversation): {
  turns: TurnState[];
  composing: ComposeState | null;
  resultShown: boolean;
  caret: boolean;
  dots: string;
} {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 55);
    return () => clearInterval(id);
  }, []);

  const T0 = 8;
  const SEND = 6;
  const THINK = 12;
  const INTENT = 14;
  const TOOL = 16;
  const CONFIRM = 16;
  const GAP = 8;
  const TOOL_START = THINK + INTENT;

  const plan: { turn: Turn; typeDur: number; start: number }[] = [];
  let acc = T0;
  for (const turn of convo.turns) {
    const typeDur = Math.ceil(turn.user.length / 2);
    plan.push({ turn, typeDur, start: acc });
    acc += typeDur + SEND + THINK + INTENT + TOOL + CONFIRM + GAP;
  }
  const totalEnd = acc;
  const f = frame % (totalEnd + 50);

  const turns: TurnState[] = [];
  let composing: ComposeState | null = null;
  for (const { turn, typeDur, start } of plan) {
    if (f < start) {
      continue;
    }
    const local = f - start;
    const sentDur = typeDur + SEND;
    const after = local - sentDur;
    if (local < sentDur) {
      const text = turn.user.slice(0, clamp(local * 2, 0, turn.user.length));
      composing = {
        text,
        full: turn.user,
        typing: local < typeDur,
        canSend: text.length > 0,
      };
    }
    let toolState: ToolState = "idle";
    if (after >= TOOL_START) {
      toolState = after < TOOL_START + TOOL ? "running" : "done";
    }
    const intentElapsed = after - THINK;
    const confirmStart = TOOL_START + TOOL;
    const confirmElapsed = after - confirmStart;
    turns.push({
      key: turn.user,
      user: turn.user.slice(0, clamp(local * 2, 0, turn.user.length)),
      fullUser: turn.user,
      typingUser: local < typeDur,
      sent: local >= sentDur,
      showAssistant: after >= 0,
      thinking: after >= 0 && after < THINK,
      showIntent: after >= THINK,
      intent: wordSlice(turn.intent, intentElapsed, INTENT),
      intentTyping: intentElapsed >= 0 && intentElapsed < INTENT,
      toolState,
      tool: turn.tool,
      showConfirm: after >= confirmStart,
      confirm: wordSlice(turn.confirm, confirmElapsed, CONFIRM),
      confirmTyping: confirmElapsed >= 0 && confirmElapsed < CONFIRM,
    });
  }

  return {
    turns,
    composing,
    resultShown: f >= totalEnd,
    caret: frame % 12 < 6,
    dots: ".".repeat((frame % 3) + 1),
  };
}

const CARET = "▉";

function CliWindow({
  meta,
  conversation,
}: {
  meta: FrameworkMeta;
  conversation: Conversation;
}): React.ReactElement {
  const run = useConversation(conversation);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background font-mono text-xs">
      <div className="flex items-center gap-2 border-border border-b px-4 py-2.5">
        <meta.Icon className="size-4" />
        <span className="font-medium">{meta.name}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-keeperhub-green" />
          keeperhub
        </span>
      </div>
      <div className="flex min-h-[300px] flex-col gap-2 px-4 py-3 leading-relaxed">
        <p className="text-muted-foreground">$ {meta.launch}</p>
        {run.turns.map((t) => (
          <Fragment key={t.key}>
            <p className="whitespace-pre-wrap break-words text-foreground">
              <span className="text-muted-foreground">&gt; </span>
              {t.user}
              {t.typingUser && run.caret ? CARET : ""}
            </p>
            {t.showAssistant ? (
              <>
                {t.thinking ? (
                  <p className="text-muted-foreground">✳ Working{run.dots}</p>
                ) : null}
                {t.showIntent ? (
                  <div className="flex gap-2">
                    <span className="shrink-0 text-keeperhub-green">●</span>
                    <span className="whitespace-pre-wrap break-words text-foreground">
                      {t.intent}
                      {t.intentTyping && run.caret ? CARET : ""}
                    </span>
                  </div>
                ) : null}
                {t.toolState === "idle" ? null : (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    Called keeperhub ({t.tool})
                    {t.toolState === "running" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : null}
                  </p>
                )}
                {t.showConfirm ? (
                  <div className="flex gap-2">
                    <span className="shrink-0 text-keeperhub-green">●</span>
                    <span className="whitespace-pre-wrap break-words text-foreground">
                      {t.confirm}
                      {t.confirmTyping && run.caret ? CARET : ""}
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ChatWindow({
  meta,
  conversation,
}: {
  meta: FrameworkMeta;
  conversation: Conversation;
}): React.ReactElement {
  const run = useConversation(conversation);
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-background">
      <div className="flex items-center gap-2 px-5 pt-4 pb-1">
        <meta.Icon className="size-4" />
        <span className="font-medium text-sm">{meta.name}</span>
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className="size-1.5 rounded-full bg-keeperhub-green" />
          connected
        </span>
      </div>

      <div className="flex min-h-[460px] flex-col gap-4 px-5 py-4">
        {run.turns.map((t) => (
          <Fragment key={t.key}>
            {t.sent ? (
              <div className="ml-auto max-w-[80%] fade-in slide-in-from-bottom-2 animate-in duration-300">
                <div className="rounded-2xl bg-muted/60 px-4 py-2.5 text-foreground text-sm">
                  {t.fullUser}
                </div>
              </div>
            ) : null}

            {t.showAssistant ? (
              <div className="flex gap-3">
                <meta.Icon className="mt-0.5 size-5 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  {t.thinking ? (
                    <p className="text-muted-foreground text-sm">
                      Thinking{run.dots}
                    </p>
                  ) : null}
                  {t.showIntent ? (
                    <p className="text-foreground text-sm leading-relaxed">
                      {t.intent}
                      {t.intentTyping && run.caret ? CARET : ""}
                    </p>
                  ) : null}
                  {t.toolState === "idle" ? null : (
                    <div className="flex items-center gap-2 self-start rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
                      {t.toolState === "running" ? (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <Check className="size-3.5 text-keeperhub-green" />
                      )}
                      <span className="text-muted-foreground">
                        Using KeeperHub
                      </span>
                      <span className="font-mono text-foreground">
                        {t.tool}
                      </span>
                    </div>
                  )}
                  {t.showConfirm ? (
                    <p className="text-foreground text-sm leading-relaxed">
                      {t.confirm}
                      {t.confirmTyping && run.caret ? CARET : ""}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Fragment>
        ))}
      </div>

      <div className="px-4 pb-4">
        <div className="rounded-2xl border border-border bg-muted/30 px-3 pt-2.5 pb-2">
          <div className="min-h-5 px-1 text-sm">
            {run.composing ? (
              <span className="text-foreground">
                {run.composing.text}
                {run.composing.typing && run.caret ? CARET : ""}
              </span>
            ) : (
              <span className="text-muted-foreground">
                How can I help today?
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between px-1">
            <Plus className="size-4 text-muted-foreground" />
            <div className="flex items-center gap-3 text-muted-foreground">
              <span className="text-xs">{meta.model}</span>
              <Mic className="size-4" />
              <AudioLines className="size-4" />
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full transition-colors",
                  run.composing?.canSend
                    ? "bg-foreground text-background"
                    : "bg-muted-foreground/20 text-muted-foreground"
                )}
              >
                <ArrowUp className="size-4" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ConnectAgentPreview({
  frameworkId,
}: {
  frameworkId: string;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState<number | null>(null);
  const meta = FRAMEWORK_META[frameworkId] ?? FALLBACK_META;
  const conversation = CONVERSATIONS[selected] ?? STETH_CONVO;

  // Measure the active window so its height animates when switching between the
  // terminal and chat layouts instead of snapping. A CSS height transition on
  // the measured pixel value tweens both grow and shrink. Zero-height reads
  // (during the key-remount swap) are ignored so the window never collapses.
  const windowRef = useRef<HTMLDivElement>(null);
  const [windowHeight, setWindowHeight] = useState<number | undefined>(
    undefined
  );
  useLayoutEffect(() => {
    const el = windowRef.current;
    if (!el) {
      return;
    }
    const measure = (): void => {
      const next = el.scrollHeight;
      if (next > 0) {
        setWindowHeight(next);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  const choose = (index: number, prompt: string): void => {
    setSelected(index);
    navigator.clipboard
      .writeText(prompt)
      .then(() => {
        setCopied(index);
        toast.success("Copied to clipboard");
        setTimeout(
          () => setCopied((current) => (current === index ? null : current)),
          1500
        );
      })
      .catch(() => undefined);
  };

  const runKey = `${frameworkId}:${selected}`;

  return (
    <div className="absolute inset-0 flex items-center justify-center px-6">
      <div className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 font-medium text-sm">
            <Sparkles className="size-4 text-primary" />
            Try a prompt
          </p>
          {CONVERSATIONS.map((convo, index) => {
            const prompt = convo.turns[0]?.user ?? "";
            const isSelected = selected === index;
            const isCopied = copied === index;
            return (
              <button
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                  isSelected
                    ? "border-keeperhub-green bg-keeperhub-green/5 text-foreground"
                    : "border-border bg-muted/30 text-muted-foreground hover:border-keeperhub-green/60 hover:text-foreground"
                )}
                key={prompt}
                onClick={() => choose(index, prompt)}
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

        <motion.div
          animate={{ height: windowHeight ?? "auto" }}
          className="overflow-hidden"
          initial={false}
          transition={{ duration: 0.3, ease: "easeInOut" }}
        >
          <div ref={windowRef}>
            {meta.kind === "cli" ? (
              <CliWindow conversation={conversation} key={runKey} meta={meta} />
            ) : (
              <ChatWindow
                conversation={conversation}
                key={runKey}
                meta={meta}
              />
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
