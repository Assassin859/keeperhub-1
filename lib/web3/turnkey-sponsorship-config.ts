import "server-only";

/**
 * Chain IDs where gas sponsorship via Turnkey's native Transaction Management
 * (Gas Station) is supported. Turnkey signs AND sponsors the underlying
 * EVM transaction in a single API call -- there is no ERC-4337 bundler or
 * paymaster involved.
 *
 * Mainnet coverage confirmed by Turnkey: Ethereum, Base, Polygon, Arbitrum.
 * Optimism is absent from Turnkey's Gas Station and was dropped from this
 * allowlist during the Pimlico -> Turnkey migration (KEEP-464). The SDK
 * v5.2.0 CAIP-2 enum lags Turnkey's actual coverage and does not yet list
 * `eip155:42161`, so `toCaip2` widens the type at the call site in
 * `turnkey-sponsored-tx.ts` until the SDK regenerates.
 */
export const SUPPORTED_SPONSORSHIP_CHAINS: ReadonlySet<number> = new Set([
  1, // Ethereum Mainnet
  11_155_111, // Sepolia
  8453, // Base
  84_532, // Base Sepolia
  137, // Polygon
  80_002, // Polygon Amoy
  42_161, // Arbitrum One
]);

export function isSponsorshipSupported(chainId: number): boolean {
  return SUPPORTED_SPONSORSHIP_CHAINS.has(chainId);
}

/**
 * Map an EVM chain ID to the CAIP-2 identifier Turnkey expects on
 * `ethSendTransaction.parameters.caip2`. Returns null for unsupported
 * chains so callers can fall back to direct signing.
 */
export function toCaip2(chainId: number): string | null {
  if (!isSponsorshipSupported(chainId)) {
    return null;
  }
  return `eip155:${chainId}`;
}
