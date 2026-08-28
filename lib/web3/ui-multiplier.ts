import { ethers } from "ethers";

/**
 * ERC-8056 UI multiplier handling.
 *
 * Robinhood Chain's stock tokens split a holding into two numbers. `balanceOf`
 * returns raw units; `balanceOfUI` returns `raw * uiMultiplier / 1e18`. A
 * corporate action such as a stock split changes the multiplier rather than
 * moving tokens, so the raw balance is untouched and the UI balance is what
 * changes. Robinhood's own app shows the UI number, and it is the one that
 * corresponds to a share count.
 *
 * `transfer` and `transferFrom` take RAW units, and the standard has no
 * `transferUI`. So the display path and the mutation path speak different units
 * and nothing on-chain reconciles them. Ignoring the multiplier is therefore
 * wrong in both directions at once: a balance reads low by the multiplier, and
 * an amount the user typed against the number they were shown transfers high by
 * it. On CRWD at 4.0 that is a 4x over-send.
 *
 * UI units are canonical here: reads are converted up, writes are converted
 * down. A plain ERC-20 has a multiplier of exactly UNIT, so every conversion is
 * the identity and no other chain changes behaviour.
 */

/** Fixed-point scale of `uiMultiplier()`, i.e. a multiplier of 1.0. */
export const UI_MULTIPLIER_UNIT = BigInt("1000000000000000000");

const UI_MULTIPLIER_ABI = [
  "function uiMultiplier() view returns (uint256)",
] as const;

/**
 * Cache of resolved multipliers, keyed by `chainId:token`.
 *
 * Negative results are cached too. Most tokens are plain ERC-20s where the call
 * reverts, and without caching the miss every balance read would pay for a
 * failed eth_call. A token that does not implement ERC-8056 cannot start doing
 * so, since that would require new code at the same address.
 *
 * Positive results carry a TTL because `updateMultiplier` is callable by the
 * issuer at any time. Five minutes bounds how long a stale multiplier can be
 * applied while keeping the steady-state cost near zero.
 */
const POSITIVE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { multiplier: bigint; fetchedAt: number | null };

const cache = new Map<string, CacheEntry>();

/** Exposed for tests; not part of the runtime contract. */
export function __clearUiMultiplierCache(): void {
  cache.clear();
}

/**
 * How to run one read against a provider.
 *
 * A function rather than the RpcManager itself, because the callers are split:
 * the transfer and approve paths hold an RpcManager and want failover, while
 * the balance readers are handed a single provider already. Both express
 * themselves in one line, and neither has to reach for the other's plumbing.
 */
export type ProviderRunner = <T>(
  operation: (provider: ethers.ContractRunner) => Promise<T>
) => Promise<T>;

/**
 * Resolve a token's ERC-8056 UI multiplier.
 *
 * Returns `UI_MULTIPLIER_UNIT` for any token that does not implement it, which
 * is every token on every chain other than Robinhood Chain. Detection is the
 * call itself rather than a chain-id allowlist, so nothing here has to be
 * updated when a chain is added, and a chain that later gains such tokens works
 * without a code change.
 *
 * Never throws. A multiplier that cannot be read falls back to UNIT, which
 * preserves today's behaviour rather than failing a transfer that would
 * otherwise succeed.
 */
export async function getUiMultiplier(
  run: ProviderRunner,
  chainId: number,
  tokenAddress: string
): Promise<bigint> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    const fresh =
      cached.fetchedAt === null ||
      Date.now() - cached.fetchedAt < POSITIVE_TTL_MS;
    if (fresh) {
      return cached.multiplier;
    }
  }

  try {
    const value = await run((provider) => {
      const contract = new ethers.Contract(
        tokenAddress,
        UI_MULTIPLIER_ABI,
        provider
      );
      return contract.uiMultiplier() as Promise<bigint>;
    });

    // A zero multiplier would silently zero every balance and make uiToRaw
    // divide by zero. Treat it as "not an ERC-8056 token" rather than trusting
    // it; no legitimate deployment reports zero.
    if (value <= BigInt(0)) {
      cache.set(key, { multiplier: UI_MULTIPLIER_UNIT, fetchedAt: null });
      return UI_MULTIPLIER_UNIT;
    }

    cache.set(key, { multiplier: value, fetchedAt: Date.now() });
    return value;
  } catch {
    // The call reverting is the ordinary case: a plain ERC-20 has no such
    // function. Cached without a timestamp so it is never re-attempted.
    cache.set(key, { multiplier: UI_MULTIPLIER_UNIT, fetchedAt: null });
    return UI_MULTIPLIER_UNIT;
  }
}

/** Raw on-chain units to the UI units a holder is shown. */
export function rawToUi(raw: bigint, multiplier: bigint): bigint {
  if (multiplier === UI_MULTIPLIER_UNIT) {
    return raw;
  }
  return (raw * multiplier) / UI_MULTIPLIER_UNIT;
}

/**
 * UI units a user typed to the raw units `transfer` expects.
 *
 * Floors. The division is rarely exact once a multiplier drifts off 1.0 through
 * dividend accrual, and rounding up would move more of the asset than the user
 * asked for. Erring low costs the user a rounding-unit of dust; erring high
 * spends their money.
 */
export function uiToRaw(ui: bigint, multiplier: bigint): bigint {
  if (multiplier === UI_MULTIPLIER_UNIT) {
    return ui;
  }
  return (ui * UI_MULTIPLIER_UNIT) / multiplier;
}

/** True when this token scales, i.e. the conversions are not the identity. */
export function isScaledToken(multiplier: bigint): boolean {
  return multiplier !== UI_MULTIPLIER_UNIT;
}
