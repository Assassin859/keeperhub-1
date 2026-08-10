import {
  Bell,
  Bot,
  Building2,
  CreditCard,
  FolderTree,
  Gauge,
  Key,
  type LucideIcon,
  Plug,
  Shield,
  User,
  Users,
  Wallet,
} from "lucide-react";

export type SettingsNavItem = {
  /** Path segment under /settings, e.g. "wallets". Unique across the nav. */
  segment: string;
  /**
   * Org-scoped sections live at /settings/<orgId>/<segment> so a link carries
   * the organization it was written for. Account-level ones have no org.
   */
  scope: "user" | "org";
  label: string;
  icon: LucideIcon;
  /** Shown on the settings index cards and as the section subtitle. */
  description: string;
  /**
   * What this section actually contains. Rendered on the index card and
   * matched by the index search, so a feature can be found by name without
   * knowing which section owns it.
   */
  contents: readonly string[];
  ownerOnly?: boolean;
  adminOnly?: boolean;
};

export type SettingsNavGroup = {
  label: string;
  items: SettingsNavItem[];
};

export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  {
    label: "Account",
    items: [
      {
        segment: "account",
        scope: "user",
        label: "Profile",
        icon: User,
        description: "Your name, email and account status.",
        contents: [
          "Name",
        "Sign-in email",
        "Deactivate account",
        ],
      },
      {
        segment: "security",
        scope: "user",
        label: "Security",
        icon: Shield,
        description:
          "Two-factor, password, wallet step-up and active sessions.",
        contents: [
          "Two-factor authentication",
        "Password",
        "Active sessions",
        "Revoke a device",
        "Organization MFA enforcement",
        "Wallet step-up",
        ],
      },
    ],
  },
  {
    label: "Organization",
    items: [
      {
        segment: "organization",
        scope: "org",
        label: "Organizations",
        icon: Building2,
        description: "Every org you belong to, with roles and switching.",
        contents: [
          "Switch organization",
        "Rename",
        "Create organization",
        "Invitations for you",
        "Your role",
        ],
      },
      {
        segment: "members",
        scope: "org",
        label: "Members",
        icon: Users,
        description: "Seats, roles and pending invitations.",
        contents: [
          "Invite by email",
        "Invite by wallet address",
        "Change roles",
        "Remove members",
        "Pending invitations",
        "Seats",
        ],
      },
      {
        segment: "notifications",
        scope: "org",
        label: "Notifications",
        icon: Bell,
        description: "Execution digest emails and who receives them.",
        contents: [
          "Execution digest email",
        "Cadence",
        "Subscribers",
        ],
        adminOnly: true,
      },
    ],
  },
  {
    label: "Money",
    items: [
      {
        segment: "wallets",
        scope: "org",
        label: "Wallets",
        icon: Wallet,
        description: "Signing wallet, Safes, balances and key export.",
        contents: [
          "Turnkey signer",
        "Safe smart accounts",
        "Balances",
        "Withdraw",
        "Tracked tokens",
        "Private key export",
        "Recovery email",
        "Deploy a Safe",
        "Signing policies",
        ],
      },
      {
        segment: "limits",
        scope: "org",
        label: "Spending limits",
        icon: Gauge,
        description: "Daily value ceilings the executor enforces before signing.",
        contents: [
          "Daily EVM cap",
        "Daily Solana cap",
        "Usage today",
        ],
        ownerOnly: true,
      },
      {
        segment: "billing",
        scope: "org",
        label: "Billing and plan",
        icon: CreditCard,
        description: "Subscription, invoices and payment method.",
        contents: [
          "Current plan",
        "Executions used",
        "Gas sponsorship credits",
        "Payment method",
        "Invoices",
        "Upgrade",
        ],
        ownerOnly: true,
      },
    ],
  },
  {
    label: "Developer",
    items: [
      {
        segment: "connections",
        scope: "org",
        label: "Connections",
        icon: Plug,
        description: "Credentials for Discord, SendGrid, databases and more.",
        contents: [
          "Discord",
        "SendGrid",
        "Databases",
        "Webhooks",
        "Credentials",
        "Connection activity",
        ],
      },
      {
        segment: "api-keys",
        scope: "org",
        label: "API keys",
        icon: Key,
        description: "Programmatic access keys and their scopes.",
        contents: [
          "Organisation keys",
        "Personal keys",
        "Scopes",
        "Revoke a key",
        "MCP endpoint",
        "Key activity",
        ],
      },
      {
        segment: "agents",
        scope: "org",
        label: "Agents",
        icon: Bot,
        description: "Connect Claude, Codex or any MCP client to this org.",
        contents: [
          "MCP endpoint",
        "Claude Code",
        "Codex",
        "Gemini CLI",
        "Goose",
        "Setup commands",
        "Starter prompts",
        ],
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        segment: "workspace",
        scope: "org",
        label: "Projects and tags",
        icon: FolderTree,
        description: "How workflows are grouped in the sidebar.",
        contents: [
          "Projects",
        "Tags",
        "Colours",
        "Sidebar grouping",
        ],
      },
    ],
  },
];

/** Where a nav entry points, given the organization currently in scope. */
export function settingsHref(
  item: SettingsNavItem,
  organizationId: string | null
): string {
  if (item.scope === "user" || !organizationId) {
    return `/settings/${item.segment}`;
  }
  return `/settings/${organizationId}/${item.segment}`;
}

/**
 * The nav entry a path belongs to. Segments are unique, so the organization id
 * in the middle of an org-scoped path does not need to be parsed out.
 */
export function findSettingsItem(pathname: string): SettingsNavItem | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "settings") {
    return null;
  }
  for (const group of SETTINGS_NAV) {
    for (const item of group.items) {
      if (parts.includes(item.segment)) {
        return item;
      }
    }
  }
  return null;
}

/** True when the path is inside this entry's section. */
export function isSettingsItemActive(
  item: SettingsNavItem,
  pathname: string
): boolean {
  return pathname.split("/").filter(Boolean).includes(item.segment);
}

export function isSettingsItemVisible(
  item: SettingsNavItem,
  access: { isOwner: boolean; isAdmin: boolean }
): boolean {
  if (item.ownerOnly && !access.isOwner) {
    return false;
  }
  if (item.adminOnly && !access.isAdmin) {
    return false;
  }
  return true;
}

/** Stable id for a settings card, so a search match can point at one. */
export function settingsAnchor(entry: string): string {
  return entry
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
