import "server-only";

/**
 * Verified protocol contract address registry.
 *
 * Every address literal is annotated inline with [VERIFIED <source> <date>].
 * Any address that could not be verified in this session is omitted entirely —
 * a TODO unverified comment marks the chain so it is simply not scanned rather
 * than producing silent wrong data.
 *
 * Verification sources:
 *   Aave V3 Pool: github.com/bgd-labs/aave-address-book (AaveV3*.sol files)
 *   Lido: docs.lido.fi/deployed-contracts (mainnet page)
 *   Chainlink: reference-data-directory.vercel.app/feeds-*.json
 */

// ─────────────────────────────────────────────────────────────────────────────
// Aave V3 Pool addresses (proxy address for getUserAccountData + getUserEMode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps chainId → Aave V3 Pool proxy contract address.
 *
 * The scanner calls getUserAccountData and getUserEMode on this contract.
 * Do NOT use the PoolDataProvider — its getReserveData returns nested tuples
 * that cause decode failures in ethers v6.
 */
export const AAVE_V3_POOLS: Record<number, string> = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // [VERIFIED github.com/bgd-labs/aave-address-book AaveV3Ethereum.sol 2026-06-16]
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // [VERIFIED github.com/bgd-labs/aave-address-book AaveV3Arbitrum.sol 2026-06-16]
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // [VERIFIED github.com/bgd-labs/aave-address-book AaveV3Polygon.sol 2026-06-16]
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // [VERIFIED github.com/bgd-labs/aave-address-book AaveV3Optimism.sol 2026-06-16]
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // [VERIFIED github.com/bgd-labs/aave-address-book AaveV3Base.sol 2026-06-16]
};

// ─────────────────────────────────────────────────────────────────────────────
// Lido stETH / wstETH contract addresses
// ─────────────────────────────────────────────────────────────────────────────

export interface LidoChainTokens {
  /** stETH (rebasing ERC20): only available on Ethereum mainnet. */
  stETH?: string;
  /** Wrapped stETH (non-rebasing); present on Ethereum + L2 bridges. */
  wstETH: string;
}

/**
 * Maps chainId → Lido token addresses for that chain.
 *
 * On L2s only raw wstETH balance is readable. The getStETHByWstETH conversion
 * function exists only on the Ethereum wstETH contract; L2 adapters report raw
 * wstETH balance only (Phase 52 may add the oracle conversion).
 */
export const LIDO_TOKENS: Record<number, LidoChainTokens> = {
  1: {
    stETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", // [VERIFIED docs.lido.fi/deployed-contracts 2026-06-16]
    wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", // [VERIFIED docs.lido.fi/deployed-contracts 2026-06-16]
  },
  42161: {
    wstETH: "0x5979D7b546E38E414F7E9822514be443A4800529", // [VERIFIED docs.lido.fi/deployed-contracts 2026-06-16] WstETH ERC20Bridged proxy
  },
  10: {
    wstETH: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", // [VERIFIED docs.lido.fi/deployed-contracts 2026-06-16] WstETH ERC20BridgedPermit proxy
  },
  8453: {
    wstETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // [VERIFIED docs.lido.fi/deployed-contracts 2026-06-16] WstETH ERC20Bridged proxy
  },
  // 137 (Polygon): TODO unverified — Lido wstETH bridge does not exist on Polygon per docs
};

// ─────────────────────────────────────────────────────────────────────────────
// Chainlink stablecoin USD price feed addresses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps chainId → { symbol → Chainlink aggregator proxy address }.
 *
 * Only Ethereum mainnet feeds are included here. The L2 Chainlink directories
 * contain multiple candidate addresses for the same symbol and cannot be
 * unambiguously resolved without additional verification. L2 stablecoin prices
 * fall back to the DefiLlama HTTP pricing layer instead.
 *
 * Chainlink feeds use 8 decimal places. Decoded price = rawAnswer / 1e8.
 */
export const STABLECOIN_CHAINLINK_FEEDS: Record<
  number,
  Record<string, string>
> = {
  1: {
    USDC: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", // [VERIFIED reference-data-directory.vercel.app feeds-mainnet.json 2026-06-16]
    USDT: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", // [VERIFIED reference-data-directory.vercel.app feeds-mainnet.json 2026-06-16]
    DAI: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", // [VERIFIED reference-data-directory.vercel.app feeds-mainnet.json 2026-06-16]
  },
  // 42161 (Arbitrum): TODO unverified — multiple USDC/USD and USDT/USD candidates; DefiLlama fallback applies
  // 10 (Optimism): TODO unverified — feeds not confirmed this session; DefiLlama fallback applies
  // 8453 (Base): TODO unverified — multiple USDC/USD candidate addresses; DefiLlama fallback applies
  // 137 (Polygon): TODO unverified — feeds not confirmed this session; DefiLlama fallback applies
};

// ─────────────────────────────────────────────────────────────────────────────
// Chain intersection helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the subset of `enabledChainIds` that have at least one registered
 * protocol address (Aave V3 Pool or Lido tokens). Chains absent from both
 * registries are silently skipped — there is nothing to scan there.
 *
 * Usage: const chainIds = scannableChainIds(await getEnabledChainIds());
 */
export function scannableChainIds(enabledChainIds: number[]): number[] {
  const registeredChainIds = new Set<number>([
    ...Object.keys(AAVE_V3_POOLS).map(Number),
    ...Object.keys(LIDO_TOKENS).map(Number),
  ]);

  return enabledChainIds.filter((chainId) => registeredChainIds.has(chainId));
}
