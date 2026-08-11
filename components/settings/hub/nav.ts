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
  Wallet,
} from "lucide-react";

export type SettingsPanel = {
  /**
   * A card title on the section's page. Search offers it as a destination, so
   * it has to match a real card: selecting it deep links to that card.
   */
  title: string;
  /**
   * Other words for the same card. Matched by search but never shown, so a
   * card is reachable by what it does as well as by what it is called.
   */
  tags?: readonly string[];
};

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
  /** The cards on this section's page, in the order the page renders them. */
  panels: readonly SettingsPanel[];
  /** Other names for the section itself, e.g. "team" for Organization. */
  tags?: readonly string[];
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
        panels: [
          {
            title: "Account details",
            tags: [
              "name",
              "display name",
              "email",
              "sign-in email",
              "change email",
              "avatar",
              "profile picture",
              "account status",
            ],
          },
          {
            title: "Deactivate account",
            tags: [
              "delete account",
              "close account",
              "disable account",
              "leave keeperhub",
            ],
          },
        ],
        tags: ["me", "personal", "user"],
      },
      {
        segment: "security",
        scope: "user",
        label: "Security",
        icon: Shield,
        description:
          "Two-factor, password, wallet step-up and active sessions.",
        panels: [
          {
            title: "Wallet step-up",
            tags: [
              "pin",
              "transaction pin",
              "wallet pin",
              "step up",
              "confirm a transaction",
              "signing confirmation",
            ],
          },
          {
            title: "Two-factor authentication",
            tags: [
              "mfa",
              "2fa",
              "two factor",
              "totp",
              "otp",
              "one-time code",
              "authenticator app",
              "backup codes",
              "recovery codes",
            ],
          },
          {
            title: "Password",
            tags: ["change password", "reset password", "passphrase"],
          },
          {
            title: "Active sessions",
            tags: [
              "devices",
              "revoke a device",
              "sign out other devices",
              "log out everywhere",
              "browsers",
            ],
          },
          {
            title: "Organization MFA enforcement",
            tags: [
              "mfa",
              "2fa",
              "require two-factor",
              "enforce mfa",
              "mandatory mfa",
              "org-wide security",
            ],
          },
        ],
        tags: ["login", "sign-in", "privacy"],
      },
    ],
  },
  {
    label: "Organization",
    items: [
      {
        segment: "organization",
        scope: "org",
        label: "Organization",
        icon: Building2,
        description: "This organization, its members and their roles.",
        panels: [
          {
            title: "Organization details",
            tags: [
              "rename organization",
              "organization name",
              "slug",
              "your role",
              "new organization",
              "create organization",
            ],
          },
          {
            title: "Members",
            tags: [
              "people",
              "team",
              "seats",
              "roles",
              "change roles",
              "remove a member",
              "owner",
              "admin",
              "permissions",
            ],
          },
          {
            title: "Outstanding invitations",
            tags: [
              "invite",
              "invite by email",
              "invite by wallet address",
              "pending invites",
              "resend invitation",
              "cancel invitation",
            ],
          },
          {
            title: "Invitations for you",
            tags: ["accept an invite", "join an organization", "my invites"],
          },
        ],
        tags: ["team", "org", "workspace", "company"],
      },
      {
        segment: "notifications",
        scope: "org",
        label: "Notifications",
        icon: Bell,
        description: "Execution digest emails and who receives them.",
        panels: [
          {
            title: "Execution digest",
            tags: [
              "digest email",
              "cadence",
              "daily summary",
              "weekly summary",
              "subscribers",
              "recipients",
              "email alerts",
            ],
          },
        ],
        tags: ["email", "alerts"],
        adminOnly: true,
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        segment: "wallets",
        scope: "org",
        label: "Wallets",
        icon: Wallet,
        description: "Signing wallet, Safes, balances and key export.",
        panels: [
          {
            title: "Accounts",
            // Assets and per-account settings live one level down, on the
            // account the row opens, and deploying a Safe is a form behind a
            // button, so none of them are cards to link to.
            tags: [
              "signing wallet",
              "turnkey signer",
              "safe smart account",
              "address",
              "balances",
              "assets",
              "tokens",
              "tracked tokens",
              "deposit",
              "withdraw",
              "private key export",
              "recovery email",
              "signing policies",
              "evm",
              "solana",
              "deploy a safe",
              "adopt a safe",
              "multisig",
              "gnosis",
            ],
          },
        ],
        tags: ["money", "funds", "treasury", "keys"],
      },
      {
        segment: "limits",
        scope: "org",
        label: "Spending limits",
        icon: Gauge,
        description:
          "Daily value ceilings the executor enforces before signing.",
        panels: [
          {
            title: "Daily value caps",
            tags: [
              "spend cap",
              "spending limit",
              "daily limit",
              "evm cap",
              "solana cap",
              "usage today",
              "transaction ceiling",
            ],
          },
        ],
        tags: ["risk", "guardrails", "budget"],
        ownerOnly: true,
      },
      {
        segment: "billing",
        scope: "org",
        label: "Billing and plan",
        icon: CreditCard,
        description: "Subscription, invoices and payment method.",
        panels: [
          {
            title: "This month",
            tags: [
              "current plan",
              "subscription",
              "executions used",
              "usage",
              "quota",
              "gas sponsorship credits",
            ],
          },
          {
            title: "Payment and invoices",
            tags: [
              "payment method",
              "card",
              "invoices",
              "receipts",
              "upgrade",
              "downgrade",
              "cancel subscription",
            ],
          },
        ],
        tags: ["pricing", "cost", "pay"],
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
        panels: [
          {
            title: "Configured connections",
            tags: [
              "credentials",
              "add a connection",
              "connection activity",
              "discord",
              "sendgrid",
              "telegram",
              "database",
              "postgres",
              "webhook",
              "secrets",
            ],
          },
        ],
        tags: ["integrations", "third party", "apps"],
      },
      {
        segment: "api-keys",
        scope: "org",
        label: "API keys",
        icon: Key,
        description: "Programmatic access keys and their scopes.",
        panels: [
          {
            title: "Organisation keys",
            tags: [
              "organization keys",
              "shared keys",
              "team keys",
              "scopes",
              "revoke a key",
              "key activity",
            ],
          },
          {
            title: "Your keys",
            tags: [
              "personal keys",
              "my keys",
              "scopes",
              "revoke a key",
              "key activity",
            ],
          },
        ],
        tags: ["token", "api token", "programmatic access", "cli"],
      },
      {
        segment: "agents",
        scope: "org",
        label: "Agents",
        icon: Bot,
        description: "Connect Claude, Codex or any MCP client to this org.",
        panels: [
          {
            title: "MCP endpoint",
            tags: ["mcp url", "server url", "model context protocol"],
          },
          {
            title: "Client setup",
            tags: [
              "claude code",
              "codex",
              "cursor",
              "gemini cli",
              "goose",
              "mcp client",
              "setup commands",
              "connect an agent",
            ],
          },
          {
            title: "Starter prompts",
            tags: ["example prompts", "sample prompts", "what to ask"],
          },
        ],
        tags: ["ai", "llm", "mcp", "assistant"],
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
        panels: [
          {
            title: "Projects",
            tags: ["folders", "group workflows", "sidebar grouping"],
          },
          {
            title: "Tags",
            tags: ["labels", "colours", "colors", "tag colour"],
          },
        ],
        tags: ["organise workflows", "sidebar"],
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

/**
 * Punctuation is not something anyone types, so "two factor" has to find
 * "Two-factor authentication" and "api key" has to find "API keys".
 */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Every word typed has to start a word in the term. Matching whole words this
 * way keeps "auth" on "authentication" while keeping "pin" off "grouping",
 * which a plain substring test cannot tell apart.
 */
function termMatches(term: string, typed: readonly string[]): boolean {
  const parts = words(term);
  return typed.every((word) => parts.some((part) => part.startsWith(word)));
}

export type SettingsMatch = {
  item: SettingsNavItem;
  panels: readonly SettingsPanel[];
};

/**
 * Sections that match the query, each with the cards inside it that matched.
 * A hit on the section's own name or tags lists all of its cards, since the
 * whole section is what was asked for.
 */
export function findSettingsMatches(
  query: string,
  access: { isOwner: boolean; isAdmin: boolean }
): SettingsMatch[] {
  const typed = words(query);
  if (typed.length === 0) {
    return [];
  }
  const hits = (terms: readonly string[] | undefined): boolean =>
    terms?.some((term) => termMatches(term, typed)) ?? false;

  const matches: SettingsMatch[] = [];
  for (const group of SETTINGS_NAV) {
    for (const item of group.items) {
      if (!isSettingsItemVisible(item, access)) {
        continue;
      }
      if (hits([item.label]) || hits(item.tags)) {
        matches.push({ item, panels: item.panels });
        continue;
      }
      const panels = item.panels.filter(
        (panel) => hits([panel.title]) || hits(panel.tags)
      );
      if (panels.length > 0) {
        matches.push({ item, panels });
      }
    }
  }
  return matches;
}
