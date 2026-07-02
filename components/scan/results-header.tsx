import { DepegBanner } from "@/components/scan/depeg-banner";
import { UnavailableChainBadges } from "@/components/scan/unavailable-chain-badges";
import { getChainName } from "@/lib/chain-utils";
import type { StablecoinBalance, UnavailableChain } from "@/lib/scan/types";

type ResultsHeaderProps = {
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
  addressKind,
  contractChains,
  unavailableChains,
  stablecoins,
}: ResultsHeaderProps): React.ReactElement {
  const depegSymbols = stablecoins
    .filter((s) => s.depegged)
    .map((s) => s.symbol);

  return (
    <>
      {addressKind !== undefined && (
        <div
          className="mb-4 flex flex-wrap items-center gap-2"
          data-testid="scan-address-summary"
        >
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 font-medium text-foreground text-xs">
            {addressKindLabel(addressKind, contractChains ?? [])}
          </span>
        </div>
      )}
      {unavailableChains.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <UnavailableChainBadges chains={unavailableChains} />
        </div>
      )}
      <DepegBanner symbols={depegSymbols} />
    </>
  );
}
