import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  fetchQuote,
  loadChainlinkFeeds,
  readChainlinkFeed,
  readOnChainState,
  resolveStockToken,
  ROBINHOOD_CHAIN_ID,
} from "./stock-token-core";

export type StockMarketStatusInput = StepInput & {
  network: string;
  symbol: string;
};

type StockMarketStatusResult =
  | {
      success: true;
      symbol: string;
      /**
       * Whether it is sane to act on this token's price right now: nothing is
       * halted or paused, and the price sources are not beyond their own
       * freshness guarantees. Gate price-reactive workflows on this.
       */
      tradeable: boolean;
      /** Every reason `tradeable` is false, so a workflow can branch on cause. */
      blockedBy: string[];
      isTradingHalt: boolean;
      oraclePaused: boolean;
      tokenPaused: boolean;
      paused: boolean;
      quoteAgeSeconds: number;
      feedAgeSeconds: number | null;
      feedBeyondHeartbeat: boolean | null;
      /** Set when a corporate action is scheduled but has not yet landed. */
      pendingMultiplier: string | null;
      pendingEffectiveAt: string | null;
    }
  | { success: false; error: string };

/**
 * How stale a quote may be before this reports it as unusable.
 *
 * The issuer's quote updates during market hours and freezes outside them, so
 * this doubles as the market-open signal: there is no endpoint that answers
 * "is the market open", and deriving one from an exchange calendar would mean
 * shipping a holiday schedule and getting half-days wrong. An hour is well
 * inside a session and unambiguously outside one.
 */
const QUOTE_USABLE_WINDOW_SECONDS = 3600;

async function stepHandler(
  input: StockMarketStatusInput
): Promise<StockMarketStatusResult> {
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (chainId !== ROBINHOOD_CHAIN_ID) {
    return {
      success: false,
      error: "Stock tokens exist only on Robinhood Chain (4663).",
    };
  }

  const resolved = await resolveStockToken(input.symbol);
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }
  const { token } = resolved;

  try {
    const rpcManager = await getRpcProvider({ chainId });
    const feeds = await loadChainlinkFeeds();
    const feed = feeds.get(token.symbol);

    const [quote, onChain, reading] = await Promise.all([
      fetchQuote(token.symbol),
      rpcManager.executeWithFailover((provider) =>
        readOnChainState(provider, token.address)
      ),
      feed
        ? rpcManager.executeWithFailover((provider) =>
            readChainlinkFeed(provider, feed)
          )
        : Promise.resolve(null),
    ]);

    const blockedBy: string[] = [];
    if (quote.isTradingHalt) {
      blockedBy.push("trading halted");
    }
    if (onChain.paused) {
      blockedBy.push("token contract paused");
    }
    if (onChain.tokenPaused) {
      blockedBy.push("transfers paused");
    }
    if (onChain.oraclePaused) {
      blockedBy.push("oracle paused");
    }
    if (quote.quoteAgeSeconds > QUOTE_USABLE_WINDOW_SECONDS) {
      blockedBy.push(
        `quote is ${quote.quoteAgeSeconds}s old, market likely closed`
      );
    }
    // Judged against the feed's own heartbeat, not a constant. These feeds run
    // on a 24 hour heartbeat and sit hours old overnight by design.
    if (reading?.beyondHeartbeat) {
      blockedBy.push(
        `price feed is ${reading.ageSeconds}s old, beyond its ${reading.heartbeatSeconds}s heartbeat`
      );
    }
    if (onChain.pendingMultiplier) {
      blockedBy.push("corporate action pending");
    }

    return {
      success: true,
      symbol: token.symbol,
      tradeable: blockedBy.length === 0,
      blockedBy,
      isTradingHalt: quote.isTradingHalt,
      oraclePaused: onChain.oraclePaused,
      tokenPaused: onChain.tokenPaused,
      paused: onChain.paused,
      quoteAgeSeconds: quote.quoteAgeSeconds,
      feedAgeSeconds: reading?.ageSeconds ?? null,
      feedBeyondHeartbeat: reading?.beyondHeartbeat ?? null,
      pendingMultiplier: onChain.pendingMultiplier,
      pendingEffectiveAt: onChain.effectiveAt
        ? new Date(onChain.effectiveAt * 1000).toISOString()
        : null,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Stock Market Status] Failed to read status",
      error,
      { plugin_name: "robinhood", action_name: "stock-market-status" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Stock Market Status
 *
 * A guard for price-reactive workflows. Out of hours the Chainlink feed freezes
 * while an AMM keeps quoting, so there is no oracle anchor and nothing
 * arbitraging the pool: acting on a price then is how a workflow gets filled
 * badly. This answers whether acting is sane, and names every reason it is not.
 */
export async function stockMarketStatusStep(
  input: StockMarketStatusInput
): Promise<StockMarketStatusResult> {
  "use step";

  return runPluginStep(
    { pluginName: "robinhood", actionName: "stock-market-status" },
    input,
    stepHandler
  );
}

stockMarketStatusStep.maxRetries = 0;

export const _integrationType = "robinhood";
