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
  /** Where this used to live, so the index can say "moved from here". */
  movedFrom?: string;
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
        movedFrom: "Avatar menu > Settings",
      },
      {
        href: "/settings/security",
        label: "Security",
        icon: Shield,
        description:
          "Two-factor, password, wallet step-up and active sessions.",
        movedFrom: "Avatar menu > Settings > Security",
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
        movedFrom: "Org switcher > Manage Organizations",
      },
      {
        href: "/settings/members",
        label: "Members",
        icon: Users,
        description: "Seats, roles and pending invitations.",
        movedFrom: "Org switcher > Manage Organizations > Organizations",
      },
      {
        href: "/settings/notifications",
        label: "Notifications",
        icon: Bell,
        description: "Execution digest emails and who receives them.",
        movedFrom: "Org switcher > Manage Organizations > Notifications",
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
        movedFrom: "Header wallet chip",
      },
      {
        href: "/settings/limits",
        label: "Spending limits",
        icon: Gauge,
        description: "Daily value ceilings the executor enforces before signing.",
        movedFrom: "Org switcher > Manage Organizations > Limits",
        ownerOnly: true,
      },
      {
        href: "/settings/billing",
        label: "Billing and plan",
        icon: CreditCard,
        description: "Subscription, invoices and payment method.",
        movedFrom: "Avatar menu > Billing",
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
        movedFrom: "Avatar menu > Connections",
      },
      {
        href: "/settings/api-keys",
        label: "API keys",
        icon: Key,
        description: "Programmatic access keys and their scopes.",
        movedFrom: "Avatar menu > API Keys",
      },
      {
        href: "/settings/agents",
        label: "Agents",
        icon: Bot,
        description: "Connect Claude, Codex or any MCP client to this org.",
        movedFrom: "Avatar menu > Connect an agent",
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
        movedFrom: "Avatar menu > Projects and Tags",
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
