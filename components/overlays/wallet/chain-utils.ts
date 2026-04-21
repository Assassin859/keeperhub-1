// TEMPO uses stablecoins for gas, so we display stablecoins only (no native token)
const TEMPO_CHAIN_IDS: ReadonlySet<number> = new Set([42_429, 4217]);

// Chains whose token lineup doesn't mirror Ethereum mainnet's stablecoin set
// (e.g. Plasma ships USDT0, no Circle USDC, no Sky USDS). For these chains we
// render the chain's own supported_tokens rows directly instead of overlaying
// them on the mainnet master list, which would otherwise produce misleading
// "Not available" entries for assets that simply don't exist on the chain.
const INDEPENDENT_TOKEN_LIST_CHAIN_IDS: ReadonlySet<number> = new Set([
  42_429, 4217, 9745,
]);

export const MAINNET_CHAIN_ID = 1;

export function isTempoChain(chainId: number): boolean {
  return TEMPO_CHAIN_IDS.has(chainId);
}

export function hasIndependentTokenList(chainId: number): boolean {
  return INDEPENDENT_TOKEN_LIST_CHAIN_IDS.has(chainId);
}

// Display order for balances view: Ethereum, Base, Tempo, then other chains.
// Mainnets and testnets are filtered into separate views; the order here
// applies within each group so mainnet Ethereum is first in mainnets and
// Sepolia Ethereum is first in testnets.
const CHAIN_DISPLAY_ORDER: Record<number, number> = {
  // Mainnets
  1: 0, // Ethereum
  8453: 1, // Base
  4217: 2, // TEMPO mainnet
  // Testnets
  11_155_111: 10, // Ethereum Sepolia
  84_532: 11, // Base Sepolia
  42_429: 12, // TEMPO testnet
} as const;

export function getChainOrderIndex(chainId: number): number {
  return CHAIN_DISPLAY_ORDER[chainId] ?? 999;
}

export function hasPositiveBalance(value: string): boolean {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0;
}
