"use client";

import { Fragment, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type Chain = {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  isTestnet: boolean;
  isEnabled: boolean;
  usePrivateMempoolRpc: boolean;
};

// KEEP-137: Suffix appended to chainId for the private mempool variant.
// The select stores compound values like "1:private" internally, but we
// split them back into config.network (the clean chainId) and
// config.usePrivateMempool (boolean) via onSelectChain.
const PRIVATE_SUFFIX = ":private";

type ChainSelectFieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /**
   * Filter chains by type (e.g., "evm" or "solana")
   * If not specified, all chain types are shown
   */
  chainTypeFilter?: string;
  /**
   * KEEP-137: When true, chains with usePrivateMempoolRpc render a second
   * "ChainName (Flashbots)" entry. On selection, both config.network and
   * config.usePrivateMempool are set via onUpdateConfig.
   */
  showPrivateVariants?: boolean;
  /**
   * Required when showPrivateVariants is true. Writes arbitrary config
   * keys (used to set usePrivateMempool alongside network).
   */
  onUpdateConfig?: (key: string, value: unknown) => void;
};

/**
 * Compute the display value for the select trigger. When a private variant is
 * active (config.usePrivateMempool is truthy), the select's stored value
 * includes the :private suffix so the trigger shows the right label.
 */
function resolveSelectValue(
  networkValue: string,
  config: Record<string, unknown>,
  showPrivateVariants: boolean
): string {
  if (showPrivateVariants && config.usePrivateMempool) {
    return `${networkValue}${PRIVATE_SUFFIX}`;
  }
  return networkValue;
}

export function ChainSelectField({
  field,
  value,
  onChange,
  disabled,
  chainTypeFilter,
  showPrivateVariants,
  onUpdateConfig,
}: ChainSelectFieldProps) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchChains() {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetch("/api/chains");
        if (!response.ok) {
          throw new Error("Failed to fetch chains");
        }

        const data = (await response.json()) as Chain[];

        // Filter by chain type if specified
        const filteredChains = chainTypeFilter
          ? data.filter((chain) => chain.chainType === chainTypeFilter)
          : data;

        setChains(filteredChains);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load chains");
      } finally {
        setIsLoading(false);
      }
    }

    fetchChains();
  }, [chainTypeFilter]);

  if (isLoading) {
    return (
      <div className="flex h-10 items-center justify-center rounded-md border">
        <Spinner className="h-4 w-4" />
        <span className="ml-2 text-muted-foreground text-sm">
          Loading chains...
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-destructive text-sm">
        {error}
      </div>
    );
  }

  if (chains.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
        No chains available
      </div>
    );
  }

  // Group chains by testnet status for better UX
  const mainnets = chains.filter((chain) => !chain.isTestnet);
  const testnets = chains.filter((chain) => chain.isTestnet);

  function onSelectChain(selectValue: string): void {
    const isPrivateVariant = selectValue.endsWith(PRIVATE_SUFFIX);
    const chainId = isPrivateVariant
      ? selectValue.slice(0, -PRIVATE_SUFFIX.length)
      : selectValue;

    // Always write the clean chainId to config.network
    onChange(chainId);

    // When showing private variants, also manage config.usePrivateMempool
    if (showPrivateVariants && onUpdateConfig) {
      onUpdateConfig("usePrivateMempool", isPrivateVariant);
    }
  }

  function renderChainItem(chain: Chain): React.ReactNode {
    return (
      <SelectItem key={chain.chainId} value={String(chain.chainId)}>
        <div className="flex items-center gap-2">
          <span>{chain.name}</span>
          <span className="text-muted-foreground text-xs">({chain.symbol})</span>
        </div>
      </SelectItem>
    );
  }

  function renderPrivateVariant(chain: Chain): React.ReactNode {
    return (
      <SelectItem
        key={`${chain.chainId}-private`}
        value={`${chain.chainId}${PRIVATE_SUFFIX}`}
      >
        <div className="flex items-center gap-2">
          <span>{chain.name} (Flashbots)</span>
          <span className="text-muted-foreground text-xs">({chain.symbol})</span>
        </div>
      </SelectItem>
    );
  }

  return (
    <Select disabled={disabled} onValueChange={onSelectChain} value={value}>
      <SelectTrigger className="w-full" id={field.key}>
        <SelectValue placeholder={field.placeholder || "Select a chain"} />
      </SelectTrigger>
      <SelectContent>
        {mainnets.length > 0 && (
          <>
            <div className="px-2 py-1.5 font-semibold text-muted-foreground text-xs">
              Mainnets
            </div>
            {mainnets.map((chain) => (
              <Fragment key={chain.chainId}>
                {renderChainItem(chain)}
                {showPrivateVariants &&
                  chain.usePrivateMempoolRpc &&
                  renderPrivateVariant(chain)}
              </Fragment>
            ))}
          </>
        )}
        {testnets.length > 0 && (
          <>
            <div className="mt-1 px-2 py-1.5 font-semibold text-muted-foreground text-xs">
              Testnets
            </div>
            {testnets.map((chain) => (
              <Fragment key={chain.chainId}>
                {renderChainItem(chain)}
                {showPrivateVariants &&
                  chain.usePrivateMempoolRpc &&
                  renderPrivateVariant(chain)}
              </Fragment>
            ))}
          </>
        )}
      </SelectContent>
    </Select>
  );
}

export { resolveSelectValue };
