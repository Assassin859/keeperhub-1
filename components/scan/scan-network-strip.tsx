import { getChainName } from "@/lib/chain-utils";
import { SCAN_NETWORK_IDS } from "@/lib/scan/networks";

/**
 * Pre-scan affordance that makes the multi-network fan-out explicit: users
 * were seeing results from several chains without ever being told the scan
 * spans them. Renders one chip per scanned network plus a one-line note that
 * both EOAs and smart contracts are supported.
 */
export function ScanNetworkStrip(): React.ReactElement {
  return (
    <div className="mt-6 flex flex-col items-center gap-2">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <span className="mr-1 text-muted-foreground text-xs">
          Scans {SCAN_NETWORK_IDS.length} networks:
        </span>
        {SCAN_NETWORK_IDS.map((chainId) => (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-[var(--color-hub-card)] px-2.5 py-0.5 font-medium text-[0.6875rem] text-foreground/80"
            key={chainId}
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-[var(--color-text-accent)]"
            />
            {getChainName(String(chainId))}
          </span>
        ))}
      </div>
      <p className="text-muted-foreground/70 text-xs">
        Works with wallets (EOAs) and smart contracts — Safes, vaults, and
        multisigs.
      </p>
    </div>
  );
}
