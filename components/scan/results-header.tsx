import { DepegBanner } from "@/components/scan/depeg-banner";
import { UnavailableChainBadges } from "@/components/scan/unavailable-chain-badges";
import type { StablecoinBalance, UnavailableChain } from "@/lib/scan/types";

type ResultsHeaderProps = {
  unavailableChains: UnavailableChain[];
  stablecoins: StablecoinBalance[];
};

export function ResultsHeader({
  unavailableChains,
  stablecoins,
}: ResultsHeaderProps): React.ReactElement {
  const depegSymbols = stablecoins
    .filter((s) => s.depegged)
    .map((s) => s.symbol);

  return (
    <>
      {unavailableChains.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <UnavailableChainBadges chains={unavailableChains} />
        </div>
      )}
      <DepegBanner symbols={depegSymbols} />
    </>
  );
}
