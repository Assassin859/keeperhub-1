/**
 * Safe Transaction Service chain prefixes (EIP-3770 slugs).
 *
 * app.safe.global deep-links use `<prefix>:<address>`, e.g.
 *   https://app.safe.global/home?safe=base:0xABC...
 *
 * Unknown chain IDs return null; the caller should hide the "View on Safe"
 * link for those rather than linking to a broken URL.
 */
const SAFE_CHAIN_PREFIXES: Record<number, string> = {
  // mainnets
  1: "eth",
  10: "oeth",
  8453: "base",
  42161: "arb1",
  56: "bnb",
  137: "matic",
  43114: "avax",
  // testnets
  11155111: "sep",
  11155420: "opsep",
  84532: "basesep",
  421614: "arbsep",
  97: "bnbt",
  80002: "amoy",
  43113: "fuji",
};

export function getSafeChainPrefix(chainId: number): string | null {
  return SAFE_CHAIN_PREFIXES[chainId] ?? null;
}

export function getSafeAppUrl(
  chainId: number,
  safeAddress: string
): string | null {
  const prefix = getSafeChainPrefix(chainId);
  if (!prefix) {
    return null;
  }
  return `https://app.safe.global/home?safe=${prefix}:${safeAddress}`;
}

/**
 * Client-side explorer URL map. Mirrors the Etherscan V2 family used by
 * scripts/seed/seed-chains.ts so we don't need to fetch explorerConfigs
 * on the client. Unknown chains return null and the UI hides the link.
 */
const EXPLORER_BASE_URLS: Record<number, string> = {
  1: "https://etherscan.io",
  10: "https://optimistic.etherscan.io",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  56: "https://bscscan.com",
  137: "https://polygonscan.com",
  43114: "https://snowtrace.io",
  11155111: "https://sepolia.etherscan.io",
  11155420: "https://sepolia-optimism.etherscan.io",
  84532: "https://sepolia.basescan.org",
  421614: "https://sepolia.arbiscan.io",
  97: "https://testnet.bscscan.com",
  80002: "https://amoy.polygonscan.com",
  43113: "https://testnet.snowtrace.io",
};

export function getExplorerAddressUrl(
  chainId: number,
  address: string
): string | null {
  const base = EXPLORER_BASE_URLS[chainId];
  if (!base) {
    return null;
  }
  return `${base}/address/${address}`;
}

export function getExplorerTxUrl(
  chainId: number,
  txHash: string
): string | null {
  const base = EXPLORER_BASE_URLS[chainId];
  if (!base) {
    return null;
  }
  return `${base}/tx/${txHash}`;
}
