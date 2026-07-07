import { FileCode2, Wallet } from "lucide-react";
import { DepegBanner } from "@/components/scan/depeg-banner";
import { UnavailableChainBadges } from "@/components/scan/unavailable-chain-badges";
import { getChainName } from "@/lib/chain-utils";
import { SCAN_NETWORK_IDS } from "@/lib/scan/networks";
import type { StablecoinBalance, UnavailableChain } from "@/lib/scan/types";

type ResultsHeaderProps = {
  ensName?: string;
  addressKind?: "eoa" | "contract";
  contractChains?: number[];
  unavailableChains: UnavailableChain[];
  stablecoins: StablecoinBalance[];
};

function addressKindLabel(
  addressKind: "eoa" | "contract",
  contractChains: number[]
): string {
  if (addressKind === "eoa") {
    return "Wallet (EOA)";
  }
  if (contractChains.length === 0) {
    return "Smart contract";
  }
  const chains = contractChains
    .map((chainId) => getChainName(String(chainId)))
    .join(", ");
  return `Smart contract on ${chains}`;
}

export function ResultsHeader({
  ensName,
  addressKind,
  contractChains,
  unavailableChains,
  stablecoins,
}: ResultsHeaderProps): React.ReactElement {
  const depegSymbols = stablecoins
    .filter((s) => s.depegged)
    .map((s) => s.symbol);

  const scannedCount = Math.max(
    0,
    SCAN_NETWORK_IDS.length - unavailableChains.length
  );
  const KindIcon = addressKind === "contract" ? FileCode2 : Wallet;

  return (
    <>
      <div
        className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="scan-address-summary"
      >
        {/* Identity: only the ENS name when the query resolved one — the raw
            address is what the user just typed, so repeating it is noise. */}
        {ensName ? (
          <span className="font-semibold text-foreground text-sm">
            {ensName}
          </span>
        ) : null}

        {addressKind !== undefined && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 font-medium text-foreground text-xs">
            <KindIcon aria-hidden="true" className="size-3.5" />
            {addressKindLabel(addressKind, contractChains ?? [])}
          </span>
        )}

        <span className="text-muted-foreground/70 text-xs">
          Scanned {scannedCount} of {SCAN_NETWORK_IDS.length} networks
        </span>
      </div>
      {unavailableChains.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <UnavailableChainBadges chains={unavailableChains} />
        </div>
      )}
      <DepegBanner symbols={depegSymbols} />
    </>
  );
}
