import { getChainName } from "@/lib/chain-utils";
import type { UnavailableChain } from "@/lib/scan/types";

type UnavailableChainBadgesProps = {
  chains: UnavailableChain[];
};

export function UnavailableChainBadges({
  chains,
}: UnavailableChainBadgesProps): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {chains.map((chain) => {
        const chainName = getChainName(String(chain.chainId));
        return (
          <span
            aria-label={`${chainName} data unavailable: ${chain.reason}`}
            className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground"
            key={chain.chainId}
            role="img"
            title={chain.reason}
          >
            {chainName}: unavailable
          </span>
        );
      })}
    </div>
  );
}
