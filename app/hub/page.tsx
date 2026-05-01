// Pure (non-"use client") module so this Server Component can call the type
// guard safely; importing through _tabs-shell would trip Next.js' RSC
// "Attempted to call isHubTabValue() from the server" error.
import { HubProtocolsTab } from "./_protocols-tab";
import { type HubTabValue, isHubTabValue } from "./_tabs-shared";
import { HubTabsShell } from "./_tabs-shell";
import { HubWorkflowsTab } from "./_workflows-tab";

type HubPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DEFAULT_TAB: HubTabValue = "protocols";

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

export default async function HubPage({
  searchParams,
}: HubPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const initialTab = readInitialTab(params.tab);
  const initialTagSlug = readTagSlug(params.tag);

  // Marketplace is the last remaining Wave-1 placeholder; plan 44-05 swaps
  // it for the real RSC tab body. Tab content is passed to HubTabsShell as
  // RSC slot props.
  const protocolsContent = <HubProtocolsTab />;
  const workflowsContent = <HubWorkflowsTab initialTagSlug={initialTagSlug} />;
  const marketplaceContent = (
    <div data-tab-placeholder="marketplace">
      Marketplace tab — pending 44-05
    </div>
  );

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-x-hidden overflow-y-auto bg-sidebar [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-h-full flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        <div className="container mx-auto max-w-7xl px-6 pt-20 pb-8">
          {/* Hero rewrite lands in plan 44-04. */}
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
