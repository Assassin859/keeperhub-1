import { DepegBanner } from "@/components/scan/depeg-banner";
import { UnavailableChainBadges } from "@/components/scan/unavailable-chain-badges";
import { relativeTime } from "@/components/settings/session-format";
import type { StablecoinBalance, UnavailableChain } from "@/lib/scan/types";

type ResultsHeaderProps = {
  scannedAt: string;
  unavailableChains: UnavailableChain[];
  stablecoins: StablecoinBalance[];
};

export function ResultsHeader({
  scannedAt,
  unavailableChains,
  stablecoins,
}: ResultsHeaderProps): React.ReactElement {
  const depegSymbols = stablecoins
    .filter((s) => s.depegged)
    .map((s) => s.symbol);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <time className="text-xs text-muted-foreground" dateTime={scannedAt}>
          {relativeTime(scannedAt)}
        </time>
        {unavailableChains.length > 0 && (
          <UnavailableChainBadges chains={unavailableChains} />
        )}
      </div>
      <DepegBanner symbols={depegSymbols} />
    </>
  );
}
