/**
 * The public, unauthenticated surface of this deployment, as data.
 *
 * One structure feeds three renderers: the React pages under app/(public)/,
 * the markdown variants served when a client negotiates `text/markdown`
 * (lib/site/markdown.ts), and the sitemap. Keeping them off a single source
 * would guarantee the HTML and the markdown drift, which is exactly the failure
 * mode `Vary: Accept` exists to prevent.
 *
 * Everything here is a statement about the product that has to stay true.
 * Pricing is derived from lib/billing/plans.ts rather than restated, so a plan
 * change cannot leave a stale number on a public page.
 */

import { PLANS, type PlanName } from "@/lib/billing/plans";
import {
  appUrl,
  docsUrl,
  formatPostalAddress,
  marketingUrl,
  postalAddress,
  privacyEmail,
  sameAs,
  supportEmail,
} from "@/lib/site/identity";

export type SiteLink = {
  label: string;
  href: string;
  description?: string;
};

export type SiteTable = {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
};

export type SiteSection = {
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  links?: readonly SiteLink[];
  table?: SiteTable;
  code?: { language: string; source: string };
};

export type SitePage = {
  /** Route path, also the key used by the markdown negotiator. */
  path: string;
  /** <title> and markdown front-matter title. */
  title: string;
  /** The single <h1>. */
  heading: string;
  /** Meta description and the lead paragraph. */
  description: string;
  sections: readonly SiteSection[];
  /** Sitemap priority; omitted pages default to 0.5. */
  priority?: number;
};

const PRODUCT_SUMMARY =
  "KeeperHub is a Web3 workflow automation platform. Teams and AI agents build, schedule, and run onchain workflows - smart contract monitoring, token transfers, DeFi operations, multi-channel notifications - through a visual builder, a REST API, a command-line tool, or a hosted Model Context Protocol server.";

const WORKFLOW_MODEL =
  "A workflow is a directed graph of nodes. A node is either a trigger (Manual, Schedule, Webhook, Event, Block) or an action supplied by a plugin. Nodes connect through edges with named source handles, and runtime values flow between them using the template syntax {{@nodeId:Label.field}}. One run of a workflow is an execution, tracked with status, logs, and metrics.";

function money(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function executionsLabel(plan: PlanName): string {
  const max = PLANS[plan].features.maxExecutionsPerMonth;
  return max < 0 ? "Custom" : `${max.toLocaleString("en-US")} / month`;
}

function gasCreditsLabel(plan: PlanName): string {
  return `${money(PLANS[plan].features.gasCreditsCents / 100)} / month`;
}

function entryPriceLabel(plan: PlanName): string {
  const [tier] = PLANS[plan].tiers;
  if (!tier) {
    return plan === "enterprise" ? "Custom" : "Usage-based";
  }
  return `${money(tier.monthlyPrice)} / month (${money(tier.monthlyPriceAnnual)} billed annually)`;
}

function overageLabel(plan: PlanName): string {
  const { overage } = PLANS[plan];
  return overage.enabled
    ? `${money(overage.ratePerThousand)} per 1,000 extra executions`
    : "Not billed";
}

const PLAN_ORDER: readonly PlanName[] = [
  "free",
  "pro",
  "business",
  "enterprise",
];

/**
 * Support-tier prose, derived rather than restated.
 *
 * `supportLevel` is a slug ("email-48h", "dedicated-12h") and `sla` is either a
 * percentage or null, so the sentence has to be assembled - but every number in
 * it comes from lib/billing/plans.ts, the same place billing reads them.
 * Hand-writing "48-hour target" is how a public page ends up quoting a response
 * time the product no longer offers, and this one is now also served as
 * markdown that agents may repeat verbatim.
 */
function supportChannel(plan: PlanName): string {
  const [channel, window] = PLANS[plan].features.supportLevel.split("-");
  if (window === undefined) {
    return "community-supported";
  }
  const medium = channel === "email" ? "email" : "a dedicated channel";
  return `${medium} with a ${window.replace("h", "-hour")} response target`;
}

/**
 * Table-cell form: "Email, 48h" rather than the raw `email-48h` slug. The slug
 * is an internal enum and was rendering straight into the public pricing table.
 */
function supportCell(plan: PlanName): string {
  const [channel, window] = PLANS[plan].features.supportLevel.split("-");
  if (window === undefined) {
    return "Community";
  }
  const medium = channel === "email" ? "Email" : "Dedicated";
  return `${medium}, ${window}`;
}

/** The channel plus the SLA, for prose that has not already named the SLA. */
function supportPhrase(plan: PlanName): string {
  const { sla } = PLANS[plan].features;
  const base = supportChannel(plan);
  return sla ? `${base} and a ${sla} availability SLA` : base;
}

function supportSummary(): string {
  const parts = PLAN_ORDER.map(
    (plan) => `${PLANS[plan].name} is ${supportPhrase(plan)}`
  );
  return `Response targets follow your plan: ${parts.join(", ")}.`;
}

function pricingTable(): SiteTable {
  return {
    headers: [
      "Plan",
      "Entry price",
      "Included executions",
      "Gas credits",
      "Overage",
      "Log retention",
      "Support",
    ],
    rows: PLAN_ORDER.map((plan) => {
      const definition = PLANS[plan];
      return [
        definition.name,
        entryPriceLabel(plan),
        executionsLabel(plan),
        gasCreditsLabel(plan),
        overageLabel(plan),
        `${definition.features.logRetentionDays} days`,
        supportCell(plan),
      ] as const;
    }),
  };
}

function tierTable(plan: PlanName): SiteTable {
  return {
    headers: ["Tier", "Executions / month", "Monthly", "Annual (per month)"],
    rows: PLANS[plan].tiers.map(
      (tier) =>
        [
          tier.key.toUpperCase(),
          tier.executions.toLocaleString("en-US"),
          money(tier.monthlyPrice),
          money(tier.monthlyPriceAnnual),
        ] as const
    ),
  };
}

function homePage(): SitePage {
  const app = appUrl();
  const docs = docsUrl();
  return {
    path: "/",
    title: "KeeperHub - Blockchain Workflow Automation",
    heading: "KeeperHub - blockchain workflow automation",
    description: PRODUCT_SUMMARY,
    priority: 1,
    sections: [
      {
        heading: "What KeeperHub does",
        paragraphs: [
          WORKFLOW_MODEL,
          "Write operations sign through an organization wallet whose private key is generated and held inside a hardware enclave, and every run is recorded with its inputs, outputs, transaction hashes, and gas usage. Organizations set spending limits and gas sponsorship policy, so an automated caller cannot exceed the budget its owners approved.",
        ],
      },
      {
        heading: "Programmatic access",
        paragraphs: [
          "Every capability in the visual builder is reachable without a browser. Agents can discover the surface from machine-readable documents and call it with an organization API key or an OAuth access token.",
        ],
        links: [
          {
            label: "Developer portal",
            href: "/developers",
            description:
              "API keys, quickstart, sandbox chains, rate limits, versioning",
          },
          {
            label: "OpenAPI specification",
            href: "/openapi.json",
            description: "Machine-readable schema for the callable endpoints",
          },
          {
            label: "MCP server",
            href: "/mcp",
            description: "OAuth-authenticated Model Context Protocol endpoint",
          },
          {
            label: "MCP server card",
            href: "/.well-known/mcp.json",
            description: "Transport, tool catalog, and authentication metadata",
          },
          {
            label: "Documentation",
            href: docs,
            description: "Concepts, plugins, API, CLI, and agent guides",
          },
          {
            label: "llms.txt",
            href: `${docs}/llms.txt`,
            description: "Canonical site map for language models",
          },
        ],
      },
      {
        heading: "Company",
        links: [
          { label: "About KeeperHub", href: "/about" },
          { label: "Pricing", href: "/pricing" },
          { label: "Contact", href: "/contact" },
          { label: "Privacy", href: "/privacy" },
          { label: "Marketing site", href: marketingUrl() },
          { label: "Sitemap", href: `${app}/sitemap.xml` },
        ],
      },
    ],
  };
}

function aboutPage(): SitePage {
  return {
    path: "/about",
    title: "About KeeperHub",
    heading: "About KeeperHub",
    description:
      "KeeperHub builds and hosts the automation layer for onchain operations, used by protocol teams, DAOs, and AI agents to run scheduled and event-driven workflows across EVM chains and Solana.",
    priority: 0.7,
    sections: [
      {
        heading: "What we build",
        paragraphs: [
          PRODUCT_SUMMARY,
          "The platform exists because onchain operations are still run by hand or by bespoke keeper bots that each team maintains alone. KeeperHub replaces that with a hosted execution layer: a visual builder for the workflow graph, managed wallets for signing, per-organization spending controls, and an execution history with logs and metrics for every run.",
          WORKFLOW_MODEL,
        ],
      },
      {
        heading: "How execution works",
        bullets: [
          "Triggers start a workflow on a schedule, an inbound webhook, an onchain event, a new block, or a manual run.",
          "Actions come from plugins - contract calls, transfers, DeFi protocol operations, HTTP requests, notifications, and sandboxed JavaScript.",
          "Write operations sign through an organization wallet whose private key is generated and held inside a hardware enclave (TEE) by Turnkey; the key never leaves that boundary during normal operation.",
          "Every run is recorded as an execution with inputs, outputs, transaction hashes, gas usage, and status.",
          "Organizations set spending limits and gas sponsorship policy, so an automated caller cannot exceed the budget its owners approved.",
        ],
      },
      {
        heading: "Built for agents, not only people",
        paragraphs: [
          "KeeperHub is designed so an autonomous agent can complete the whole loop: discover the available workflows, read their input schemas, call them, and check the result. That surface is public and documented rather than reverse-engineered.",
        ],
        links: [
          {
            label: "Model Context Protocol server",
            href: "/mcp",
            description: "Streamable HTTP transport, OAuth-authenticated",
          },
          {
            label: "Public MCP surface",
            href: "/mcp/public",
            description:
              "Anonymous initialize, tools/list, and calls to listed workflows",
          },
          {
            label: "ERC-8004 agent card",
            href: "/.well-known/agent-card.json",
            description: "Onchain agent registration and identity",
          },
          {
            label: "x402 payment metadata",
            href: "/.well-known/x402",
            description: "Per-call pricing for paid workflow endpoints",
          },
        ],
      },
      {
        heading: "Where to go next",
        links: [
          { label: "Developer portal", href: "/developers" },
          { label: "Pricing", href: "/pricing" },
          { label: "Documentation", href: docsUrl() },
          { label: "Contact us", href: "/contact" },
        ],
      },
    ],
  };
}

function contactPage(): SitePage {
  const address = postalAddress();
  const social = sameAs();
  return {
    path: "/contact",
    title: "Contact KeeperHub",
    heading: "Contact KeeperHub",
    description:
      "How to reach KeeperHub for product support, security reports, privacy requests, sales, and bug reports, with the response channel for each.",
    priority: 0.6,
    sections: [
      {
        heading: "Support",
        paragraphs: [
          `Email ${supportEmail()} for anything about your account, a workflow that is not behaving, billing, or plan changes. Include your organization name and, where the question is about a specific run, the execution id shown on the run page - that is the fastest route to a precise answer.`,
          supportSummary(),
        ],
        links: [
          {
            label: `Email ${supportEmail()}`,
            href: `mailto:${supportEmail()}`,
          },
        ],
      },
      {
        heading: "Privacy and data requests",
        paragraphs: [
          `Email ${privacyEmail()} to access, correct, export, or delete the personal data held about you, or to raise a GDPR or CCPA request. The full policy, including what is collected and how long it is retained, is published on the privacy page.`,
        ],
        links: [
          {
            label: `Email ${privacyEmail()}`,
            href: `mailto:${privacyEmail()}`,
          },
          { label: "Privacy policy", href: "/privacy" },
        ],
      },
      {
        heading: "Bugs and feature requests",
        paragraphs: [
          "Reproducible bugs and feature requests are tracked in public on GitHub. Filing there rather than by email means the issue is visible to everyone hitting the same thing, and the fix is linked to the commit that ships it.",
        ],
        links: [
          {
            label: "GitHub issues",
            href: "https://github.com/KeeperHub/keeperhub/issues",
          },
        ],
      },
      {
        heading: "Security",
        paragraphs: [
          `Report a suspected vulnerability to ${supportEmail()} with "security" in the subject line. Please do not open a public issue for an unpatched vulnerability, and include enough detail to reproduce it.`,
        ],
      },
      ...(address
        ? [
            {
              heading: "Postal address",
              paragraphs: [formatPostalAddress(address)],
            } satisfies SiteSection,
          ]
        : []),
      ...(social.length > 0
        ? [
            {
              heading: "Elsewhere",
              links: social.map((href) => ({ label: href, href })),
            } satisfies SiteSection,
          ]
        : []),
    ],
  };
}

function privacyPage(): SitePage {
  return {
    path: "/privacy",
    title: "Privacy at KeeperHub",
    heading: "Privacy at KeeperHub",
    description:
      "What KeeperHub collects, how credentials and wallet keys are protected, how long execution data is kept, and how to exercise your data rights. The full legal policy is published on the marketing site.",
    priority: 0.6,
    sections: [
      {
        heading: "Scope of this page",
        paragraphs: [
          `This page summarises how the application at ${appUrl()} handles data, so a reader - or an agent evaluating the service - does not have to parse the full legal text to answer the common questions. The complete and canonical privacy policy, including the GDPR and CCPA sections, lives at ${marketingUrl()}/privacy and governs in case of any difference.`,
        ],
        links: [
          {
            label: "Full privacy policy",
            href: `${marketingUrl()}/privacy`,
          },
        ],
      },
      {
        heading: "What is collected",
        bullets: [
          "Account information: email address, name, organization membership, and authentication factors.",
          "Workflow configuration: node types, contract addresses, parameters, schedules, and conditions you define.",
          "Execution records: inputs, outputs, transaction hashes, gas usage, and status for each run.",
          "Operational telemetry: request logs and error reports used to keep the service running.",
        ],
      },
      {
        heading: "How credentials are protected",
        bullets: [
          "API keys are hashed with SHA-256 before storage. Only the key prefix is retained, for identification in the dashboard.",
          "Wallet private keys are generated and held inside Turnkey's secure hardware enclaves. KeeperHub does not store them and cannot move funds outside the transactions your workflows define.",
          // Deliberately narrower than the first draft, which also asserted
          // encryption at rest. lib/db/schema.ts:571 carries a comment saying
          // credentials are stored encrypted, but no encryption path for them
          // was found in the codebase, and a code comment is not evidence
          // enough to publish a security commitment on a page agents quote.
          // What is below is verifiable: lib/credential-fetcher.ts fetches by
          // integration id at runtime, in memory, and steps take the id rather
          // than the secret so it never reaches step parameters or logs.
          "Third-party integration credentials are never passed to workflow steps or written to execution logs. A step receives only an integration id and fetches the credential in memory at the moment it is used.",
          "Two-factor authentication is mandatory on email-password accounts, and new sign-in devices and countries are verified before a session is granted.",
        ],
      },
      {
        heading: "Retention",
        paragraphs: [
          `Execution logs are retained for the window your plan includes: ${PLAN_ORDER.map((plan) => `${PLANS[plan].name} ${PLANS[plan].features.logRetentionDays} days`).join(", ")}. Account deletion is a soft delete: the account is deactivated and every session is invalidated, and workflow definitions should be exported first if you want to keep them.`,
        ],
      },
      {
        heading: "Your rights",
        paragraphs: [
          `Email ${privacyEmail()} to request access to, correction of, export of, or deletion of your personal data, or to restrict processing. Requests from the European Economic Area are handled under GDPR and requests from California under the CCPA.`,
        ],
        links: [
          {
            label: `Email ${privacyEmail()}`,
            href: `mailto:${privacyEmail()}`,
          },
          { label: "Contact page", href: "/contact" },
        ],
      },
    ],
  };
}

function pricingPage(): SitePage {
  return {
    path: "/pricing",
    title: "KeeperHub pricing",
    heading: "KeeperHub pricing",
    description:
      "Plans, included executions, gas credits, overage rates, and support levels for KeeperHub. Start free with pay-per-execution; upgrade for higher included volume and faster support.",
    priority: 0.8,
    sections: [
      {
        heading: "Plans",
        paragraphs: [
          "Every plan includes all supported EVM chains and Solana, the visual and AI workflow builders, the REST API, the CLI, and the hosted MCP server. Plans differ in included execution volume, gas credits, log retention, and support response time.",
          "The Free plan is self-serve and needs no sales conversation: sign up, create an API key, and start calling the API. Pro and Business are self-serve upgrades with monthly or annual billing; annual billing is charged at the lower per-month rate shown below.",
        ],
        table: pricingTable(),
      },
      {
        heading: "Pro tiers",
        paragraphs: [
          "Pro scales in tiers. Executions beyond the included volume are billed at the overage rate rather than blocked.",
        ],
        table: tierTable("pro"),
      },
      {
        heading: "Business tiers",
        paragraphs: [
          `Business adds a ${PLANS.business.features.sla} availability SLA, ${PLANS.business.features.logRetentionDays}-day log retention, and ${supportChannel("business")}.`,
        ],
        table: tierTable("business"),
      },
      {
        heading: "Marketplace workflows",
        paragraphs: [
          "Workflows published to the marketplace can carry their own per-call price, independent of your subscription. A paid endpoint answers the first unpaid call with HTTP 402 and a payment challenge; a client that settles the challenge and replays the request gets the result. Accepted protocols and the price for each endpoint are declared in the OpenAPI document.",
        ],
        links: [
          { label: "OpenAPI specification", href: "/openapi.json" },
          { label: "x402 payment metadata", href: "/.well-known/x402" },
        ],
      },
      {
        heading: "Enterprise",
        paragraphs: [
          `Enterprise covers custom execution volume, a ${PLANS.enterprise.features.sla} availability SLA, ${PLANS.enterprise.features.logRetentionDays}-day log retention, and ${supportChannel("enterprise")}. Terms are agreed directly rather than published.`,
        ],
        links: [
          { label: "Contact us", href: "/contact" },
          {
            label: "Enterprise overview",
            href: `${marketingUrl()}/enterprise`,
          },
        ],
      },
    ],
  };
}

function developersPage(): SitePage {
  const app = appUrl();
  const docs = docsUrl();
  return {
    path: "/developers",
    title: "KeeperHub developer portal",
    heading: "KeeperHub developer portal",
    description:
      "Everything needed to integrate KeeperHub without a browser: API keys, the OpenAPI document, the MCP server, the CLI, testnet sandboxes, rate limits, the error model, and the versioning policy.",
    priority: 0.9,
    sections: [
      {
        heading: "Machine-readable entry points",
        paragraphs: [
          "Start from one of these documents rather than by scraping the application. Each is served without authentication and describes the surface it belongs to.",
        ],
        links: [
          {
            label: "OpenAPI 3.1 document",
            href: "/openapi.json",
            description:
              "Callable endpoints, request and response schemas, the typed error model, pricing, and rate-limit headers",
          },
          {
            label: "MCP server card",
            href: "/.well-known/mcp.json",
            description: "Transport, tool catalog, and authentication metadata",
          },
          {
            label: "MCP endpoint (well-known alias)",
            href: "/.well-known/mcp",
            description:
              "Streamable HTTP transport; accepts an anonymous initialize handshake",
          },
          {
            label: "Agent card",
            href: "/.well-known/agent-card.json",
            description: "ERC-8004 identity and onchain registration",
          },
          {
            label: "llms.txt",
            href: `${docs}/llms.txt`,
            description: "Canonical site map for language models",
          },
          {
            label: "Sitemap",
            href: `${app}/sitemap.xml`,
            description: "Crawlable public pages",
          },
        ],
      },
      {
        heading: "Get an API key",
        paragraphs: [
          "Sign up for the Free plan - no sales contact, no waiting list - then open your avatar menu and choose API Keys. There are two key systems and they are not interchangeable: organization keys (prefix kh_) authenticate the REST API and the MCP server, and user keys (prefix wfb_) authenticate webhook triggers. Browser OAuth mints a short-lived Bearer access token instead, which the same endpoints accept.",
          "Confirm the credential before building on it. GET /api/keys is the auth probe: 200 means the key is valid and scoped to an organization, 401 means it is not. GET /api/chains is public and answers either way, so it tests reachability rather than the credential.",
        ],
        code: {
          language: "bash",
          source: `curl -sf -H "Authorization: Bearer kh_your_api_key" \\\n  ${app}/api/keys`,
        },
        links: [{ label: "API key reference", href: `${docs}/api/api-keys` }],
      },
      {
        heading: "Connect an agent over MCP",
        paragraphs: [
          "The hosted Model Context Protocol server is the fastest path from an AI agent to a running workflow. It speaks Streamable HTTP and accepts either an OAuth access token or an organization API key. Each listed marketplace workflow is additionally exposed as its own typed MCP server.",
        ],
        code: {
          language: "bash",
          source: `claude mcp add --transport http --scope user keeperhub ${app}/mcp\n\n# headless / CI, using an organization key instead of browser OAuth\nclaude mcp add --transport http --scope user keeperhub ${app}/mcp \\\n  --header "Authorization: Bearer kh_your_key_here"`,
        },
        links: [
          { label: "MCP server reference", href: `${docs}/agent/mcp-server` },
          {
            label: "Per-workflow MCP servers",
            href: `${docs}/workflows/marketplace`,
          },
        ],
      },
      {
        heading: "Command-line tool",
        paragraphs: [
          "kh is the official KeeperHub CLI. It signs in with the OAuth device-code flow, so it works on headless and remote machines, and stores the token in the OS keyring. Every command is scriptable, which makes it the lowest-effort way for an agent to drive the platform without writing an HTTP client.",
        ],
        code: {
          language: "bash",
          source:
            "brew install keeperhub/tap/kh\nkh auth login\nkh workflow list",
        },
        links: [{ label: "CLI quickstart", href: `${docs}/cli/quickstart` }],
      },
      {
        heading: "Sandbox and testing",
        paragraphs: [
          "There is no separate sandbox host to provision. Test against the supported testnets with a funded organization wallet, and preflight every write before broadcasting it.",
        ],
        bullets: [
          "Ethereum Sepolia (chain id 11155111) and Base Sepolia (chain id 84532) are supported testnets; fund the organization wallet reported by GET /api/user with native gas, then with test USDC.",
          "Direct-execution tools accept simulate: true, which reports whether the transaction would revert without broadcasting it. Simulation is EVM-only; on Solana the call resolves with isError and the code simulation_unsupported_chain.",
          "Workflows can be validated before they are saved, and a saved workflow can be run once manually before any trigger is attached.",
          "The Code action runs untrusted JavaScript inside an isolated node:vm sandbox with outbound SSRF protection.",
        ],
        links: [
          { label: "Supported chains", href: "/api/chains" },
          { label: "Platform reference", href: `${docs}/platform-reference` },
        ],
      },
      {
        heading: "Rate limits",
        paragraphs: [
          "Limited responses carry Retry-After in delta seconds; successful responses on limited endpoints carry the current window state so a client can throttle before it is refused. Both the RFC-style RateLimit-* headers and the older X-RateLimit-* spellings are sent on every limited endpoint.",
        ],
        table: {
          headers: ["Context", "Limit"],
          rows: [
            ["MCP, per organization", "120 / minute"],
            ["Public MCP tools/call, per IP", "10 / minute"],
            ["Direct execution, per API key", "60 / minute"],
          ],
        },
        bullets: [
          "RateLimit-Limit and X-RateLimit-Limit: requests allowed in the current window.",
          "RateLimit-Remaining and X-RateLimit-Remaining: requests left in the current window.",
          "RateLimit-Reset: seconds until the window resets. X-RateLimit-Reset: the same moment as a Unix timestamp.",
          "Retry-After: on a 429, the minimum number of seconds to wait before retrying.",
          "X-Poll-Interval-Hint: on status endpoints, the number of seconds to wait before polling again; 0 means the execution is terminal.",
        ],
      },
      {
        heading: "Error model",
        paragraphs: [
          "Every REST error returns the same JSON envelope, so a client branches on a stable code instead of matching on prose. error is a snake_case code that does not change across releases, detail is human-readable, hint is the suggested next step, docs is an optional deep link, and request_id correlates the call with our logs and is echoed on the x-request-id response header.",
        ],
        code: {
          language: "json",
          source: `{\n  "error": "rate_limited",\n  "detail": "Too many requests for this API key",\n  "hint": "Wait for the number of seconds in Retry-After, then retry",\n  "request_id": "req_01J..."\n}`,
        },
        bullets: [
          "unauthorized: the credential is missing, malformed, or revoked.",
          "insufficient_scope: the credential is valid but not permitted for this operation.",
          "not_found: the route or the resource does not exist.",
          "invalid_input: the request body or query failed validation.",
          "conflict: the request contradicts current state, for example a duplicate idempotency key with a different body.",
          "rate_limited: the caller exceeded a published limit; Retry-After is set.",
          "internal_error: an unexpected server fault; retry with backoff and quote request_id if it persists.",
        ],
      },
      {
        heading: "Versioning and deprecation",
        paragraphs: [
          "The REST surface is version 1. Send the optional KeeperHub-Version request header to pin a call to a version; omitting it selects the current version. Additive changes - new endpoints, new optional fields, new enum members - ship inside a version and do not require action from you.",
          'A breaking change ships as a new version, never in place. When a version or endpoint is scheduled for removal, its responses carry the Deprecation header (RFC 9745) with the date the deprecation took effect, the Sunset header (RFC 8594) with the earliest date it may stop working, and a Link header with rel="deprecation" pointing at the migration note. A sunset date is never less than 180 days after the Deprecation header first appears.',
        ],
        bullets: [
          "Current version: 1. Header: KeeperHub-Version: 1.",
          "Deprecation: <http-date> marks an endpoint as deprecated but still working.",
          "Sunset: <http-date> is the earliest date the endpoint may be withdrawn.",
          'Link: <url>; rel="deprecation" points at what to migrate to.',
          "Minimum notice between Deprecation and Sunset: 180 days.",
        ],
      },
      {
        heading: "Documentation",
        links: [
          { label: "Getting started", href: `${docs}/getting-started` },
          { label: "REST API reference", href: `${docs}/api` },
          { label: "Agent guide", href: `${docs}/getting-started/agent` },
          {
            label: "Workflow schema reference",
            href: `${docs}/workflows/schema-reference`,
          },
          { label: "Pricing", href: "/pricing" },
          { label: "Contact us", href: "/contact" },
        ],
      },
    ],
  };
}

/**
 * Every public page, keyed by path. Built per call rather than frozen at module
 * load so a deployment's environment (app URL, docs URL, contact addresses) is
 * read at request time, matching how lib/agent-identity.ts behaves.
 */
export function publicPages(): Record<string, SitePage> {
  const pages = [
    homePage(),
    aboutPage(),
    contactPage(),
    privacyPage(),
    pricingPage(),
    developersPage(),
  ];
  const byPath: Record<string, SitePage> = {};
  for (const page of pages) {
    byPath[page.path] = page;
  }
  return byPath;
}

export function publicPage(path: string): SitePage | null {
  return publicPages()[path] ?? null;
}

/** Pages backed by a SitePage, in sitemap order. */
export const PUBLIC_PAGE_PATHS: readonly string[] = [
  "/",
  "/developers",
  "/pricing",
  "/about",
  "/contact",
  "/privacy",
];

/**
 * Paths that participate in Accept negotiation. `/welcome` is included because
 * it is where `/` sends a signed-out visitor, so an agent that follows the
 * redirect and then asks for markdown must get the same answer as one that
 * asked at `/`.
 */
export const NEGOTIABLE_PATHS: readonly string[] = [
  ...PUBLIC_PAGE_PATHS,
  "/welcome",
];

/** The SitePage a negotiable path resolves to. */
export function negotiablePage(path: string): SitePage | null {
  return publicPage(path === "/welcome" ? "/" : path);
}
