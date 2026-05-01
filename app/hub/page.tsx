// Pure (non-"use client") module so this Server Component can call the type
// guard safely; importing through _tabs-shell would trip Next.js' RSC
// "Attempted to call isHubTabValue() from the server" error.
import { type HubTabValue, isHubTabValue } from "./_tabs-shared";
import { HubTabsShell } from "./_tabs-shell";

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

export default async function HubPage({
  searchParams,
}: HubPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const initialTab = readInitialTab(params.tab);

  // Wave-1 placeholders. Wave-2 plans (44-02, 44-03, 44-05) replace these
  // with real RSC tab bodies. The tab shell streams them as RSC slot props.
  const protocolsContent = (
    <div data-tab-placeholder="protocols">Protocols tab — pending 44-03</div>
  );
  const workflowsContent = (
    <div data-tab-placeholder="workflows">Workflows tab — pending 44-02</div>
  );
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
