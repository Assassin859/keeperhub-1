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
  href: string;
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
        href: "/settings/account",
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
        href: "/settings/security",
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
        href: "/settings/organization",
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
        href: "/settings/members",
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
        href: "/settings/notifications",
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
        href: "/settings/wallets",
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
        href: "/settings/limits",
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
        href: "/settings/billing",
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
        href: "/settings/connections",
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
        href: "/settings/api-keys",
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
        href: "/settings/agents",
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
        href: "/settings/workspace",
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

/** Longest matching nav entry, so nested routes still name their section. */
export function findSettingsItem(pathname: string): SettingsNavItem | null {
  let match: SettingsNavItem | null = null;
  for (const group of SETTINGS_NAV) {
    for (const item of group.items) {
      const isMatch =
        pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (isMatch && (!match || item.href.length > match.href.length)) {
        match = item;
      }
    }
  }
  return match;
}

/** Case-insensitive match across the label, blurb and contents. */
export function matchesSettingsQuery(
  item: SettingsNavItem,
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystack = [item.label, item.description, ...item.contents]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
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
