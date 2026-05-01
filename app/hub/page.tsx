// Pure (non-"use client") module so this Server Component can call the type
// guard safely; importing through _tabs-shell would trip Next.js' RSC
// "Attempted to call isHubTabValue() from the server" error.
import type { Metadata } from "next";
import { HubHero } from "@/components/hub/hub-hero";
import { HubMarketplaceTab } from "./_marketplace-tab";
import { HubProtocolsTab } from "./_protocols-tab";
import { type HubTabValue, isHubTabValue } from "./_tabs-shared";
import { HubTabsShell } from "./_tabs-shell";
import { HubWorkflowsTab } from "./_workflows-tab";

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

// MARKET-05: align RSC revalidate with the unstable_cache TTL used by
// fetchMarketplaceLeaderboard so Next's CDN headers stay coherent. The
// literal `Cache-Control: s-maxage=300, stale-while-revalidate=60` header
// from the spec is achieved at-CDN via the route segment's revalidate +
// the cached query; if 44-11 e2e flags the literal header string as a
// contract gap, a thin middleware override lands as a follow-up.
export const revalidate = 60;

type HubPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type MetadataProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type TabMetadata = {
  title: string;
  description: string;
};

const DEFAULT_TAB: HubTabValue = "protocols";

// MARKET-12: per-tab title + description. OG image stays on the existing
// /api/og/hub default route for all tabs (per HUB-FUTURE-02 — per-tab OG
// generation is deferred). Default branch (no `?tab=`) uses the umbrella
// "Hub" title rather than the per-tab string so direct shares to /hub keep
// surfacing all three tabs in the description.
const TAB_METADATA: Record<HubTabValue | "default", TabMetadata> = {
  default: {
    title: "Hub — KeeperHub",
    description:
      "Browse protocols, fork community workflows, and discover paid services on the marketplace.",
  },
  protocols: {
    title: "Protocols — Hub | KeeperHub",
    description:
      "Browse Web3 protocols KeeperHub workflows can interact with — Aave, Uniswap, Compound, and more.",
  },
  workflows: {
    title: "Workflows — Hub | KeeperHub",
    description:
      "Browse community workflow templates. Fork any template to your organisation in one click.",
  },
  marketplace: {
    title: "Marketplace — Hub | KeeperHub",
    description:
      "Discover paid services. Listed workflows ranked by call count, callable by humans and AI agents.",
  },
} as const;

function readInitialTab(value: string | string[] | undefined): HubTabValue {
  if (typeof value !== "string") {
    return DEFAULT_TAB;
  }
  const normalized = value.trim().toLowerCase();
  return isHubTabValue(normalized) ? normalized : DEFAULT_TAB;
}

function readTagSlug(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function metaForTab(value: string | string[] | undefined): TabMetadata {
  if (typeof value !== "string") {
    return TAB_METADATA.default;
  }
  const normalized = value.trim().toLowerCase();
  return isHubTabValue(normalized)
    ? TAB_METADATA[normalized]
    : TAB_METADATA.default;
}

export async function generateMetadata({
  searchParams,
}: MetadataProps): Promise<Metadata> {
  const params = await searchParams;
  const meta = metaForTab(params.tab);
  const ogImageUrl = `${APP_BASE_URL}/api/og/hub`;
  return {
    title: meta.title,
    description: meta.description,
    openGraph: {
      title: meta.title,
      description: meta.description,
      type: "website",
      url: `${APP_BASE_URL}/hub`,
      siteName: "KeeperHub",
      // HUB-FUTURE-02: per-tab OG generation deferred. Default Hub OG used
      // for every tab — keeps the share-card story coherent until the
      // per-tab OG renderer ships.
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: "KeeperHub Hub",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      images: [ogImageUrl],
    },
  };
}

export default async function HubPage({
  searchParams,
}: HubPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const initialTab = readInitialTab(params.tab);
  const initialTagSlug = readTagSlug(params.tag);

  // Tab content is passed to HubTabsShell as RSC slot props.
  const protocolsContent = <HubProtocolsTab />;
  const workflowsContent = <HubWorkflowsTab initialTagSlug={initialTagSlug} />;
  const marketplaceContent = <HubMarketplaceTab searchParams={params} />;

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-x-hidden overflow-y-auto bg-sidebar [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-h-full flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        <div className="container mx-auto max-w-7xl px-6 pt-20 pb-8">
          <HubHero />
          <HubTabsShell
            initialTab={initialTab}
            marketplaceContent={marketplaceContent}
            protocolsContent={protocolsContent}
            workflowsContent={workflowsContent}
          />
        </div>
      </div>
    </div>
  );
}
