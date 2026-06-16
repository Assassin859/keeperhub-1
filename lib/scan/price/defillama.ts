import "server-only";

import { safeFetch } from "@/lib/safe-fetch";

/**
 * DefiLlama chain slug map for the `coins.llama.fi/prices/current` API.
 *
 * DefiLlama uses its own slug convention (not EVM chain IDs or standard
 * network names).  Tokens on chains absent from this map resolve to null
 * (N/A) rather than a $0 guess — DefiLlama cannot be queried without a
 * valid slug (Pitfall 6 in RESEARCH: slug mismatch produces empty response
 * with no error).
 */
export const DEFILLAMA_CHAIN_SLUGS: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
};

type DefillamaCoinsResponse = {
  coins: Record<
    string,
    { price: number; decimals: number; symbol: string; timestamp: number }
  >;
};

/**
 * Fetches the current USD price of a token from DefiLlama's coins API.
 *
 * Uses `safeFetch` (SSRF-guarded) for the outbound request (T-51-04-01).
 * The URL is a fixed public host; the only variable is the token address
 * path segment (lowercased — not user-supplied raw input).
 *
 * Returns null on any failure — an API outage or an unsupported chain
 * degrades gracefully to "N/A", never to $0 (SCAN-09, T-51-04-02).
 *
 * @param chainId      - EVM chain ID (must be in DEFILLAMA_CHAIN_SLUGS)
 * @param tokenAddress - ERC-20 token contract address (checksummed or not)
 */
export async function fetchDefillamaPrice(
  chainId: number,
  tokenAddress: string
): Promise<number | null> {
  const chainSlug = DEFILLAMA_CHAIN_SLUGS[chainId];
  if (chainSlug === undefined) {
    return null;
  }

  const coinId = `${chainSlug}:${tokenAddress.toLowerCase()}`;
  const url = `https://coins.llama.fi/prices/current/${coinId}`;

  try {
    const resp = await safeFetch(url, { plugin: "scan-defillama" });
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as DefillamaCoinsResponse;
    return data.coins[coinId]?.price ?? null;
  } catch {
    return null;
  }
}
