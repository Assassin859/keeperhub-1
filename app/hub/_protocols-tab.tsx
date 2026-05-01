import { Box } from "lucide-react";
import "@/protocols";
import {
  getRegisteredProtocols,
  type ProtocolDefinition,
} from "@/lib/protocol-registry";
import { ProtocolDetailIsland } from "./_protocol-detail-island";
import { ProtocolGridClient } from "./_protocols-grid-client";

type HubProtocolsTabProps = {
  query: string;
};

function matchesQuery(protocol: ProtocolDefinition, q: string): boolean {
  const haystack =
    `${protocol.name} ${protocol.description ?? ""}`.toLowerCase();
  return haystack.includes(q);
}

export function HubProtocolsTab({
  query,
}: HubProtocolsTabProps): React.ReactElement {
  // Read from the in-process registry — same source the /api/protocols route
  // serves. Avoids an HTTP hop for the SSR render and keeps the data path
  // independent of the Workflows tab (per CONTEXT.md "no coupling").
  const all = getRegisteredProtocols();
  const trimmed = query.trim().toLowerCase();
  const protocols =
    trimmed === "" ? all : all.filter((p) => matchesQuery(p, trimmed));

  if (all.length === 0) {
    return (
      <section
        aria-label="Protocols"
        className="flex flex-col items-center rounded-xl border border-border/30 border-dashed bg-[var(--color-hub-card)] p-12 text-center"
      >
        <Box aria-hidden="true" className="size-8 text-muted-foreground/50" />
        <h2 className="mt-4 font-semibold text-foreground text-sm">
          No protocols available yet.
        </h2>
        <p className="mt-1 text-muted-foreground text-xs">
          Protocols are added by the KeeperHub team. Check back soon.
        </p>
      </section>
    );
  }

  if (protocols.length === 0) {
    return (
      <section
        aria-label="Protocols"
        className="flex flex-col items-center rounded-xl border border-border/30 border-dashed bg-[var(--color-hub-card)] p-12 text-center"
      >
        <Box aria-hidden="true" className="size-8 text-muted-foreground/50" />
        <h2 className="mt-4 font-semibold text-foreground text-sm">
          No protocols match “{query}”.
        </h2>
        <p className="mt-1 text-muted-foreground text-xs">
          Try a different keyword or clear the search.
        </p>
      </section>
    );
  }

  return (
    <>
      <ProtocolGridClient protocols={protocols} />
      <ProtocolDetailIsland protocols={all} />
    </>
  );
}
