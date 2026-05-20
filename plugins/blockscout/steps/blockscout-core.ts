import "server-only";

import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getErrorMessage } from "@/lib/utils";
import type { BlockscoutCredentials } from "../credentials";

// Default public Blockscout instance (Ethereum mainnet), used when no chain is
// selected and no custom instance URL is configured.
const DEFAULT_BLOCKSCOUT_API_URL = "https://eth.blockscout.com";

// Strips one or more trailing slashes so paths can be appended consistently.
const TRAILING_SLASH_RE = /\/+$/;

/**
 * Canonical hosted Blockscout instance per chain ID. Lets a workflow pick a
 * chain on the node and query the right explorer with zero connection setup.
 * Chains not listed here require a Blockscout connection with an explicit
 * instance URL (BLOCKSCOUT_API_URL).
 */
export const BLOCKSCOUT_INSTANCES: Record<number, string> = {
  1: "https://eth.blockscout.com",
  11_155_111: "https://eth-sepolia.blockscout.com",
  8453: "https://base.blockscout.com",
  84_532: "https://base-sepolia.blockscout.com",
  10: "https://explorer.optimism.io",
  42_161: "https://arbitrum.blockscout.com",
  100: "https://gnosis.blockscout.com",
  137: "https://polygon.blockscout.com",
};

export const SUPPORTED_BLOCKSCOUT_CHAIN_IDS = Object.keys(BLOCKSCOUT_INSTANCES);

export type BlockscoutFetchResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

type InstanceResolution =
  | { url: string }
  | { error: string };

/**
 * Resolve which Blockscout instance to query.
 *
 * Precedence:
 *   1. An explicit connection instance URL (BLOCKSCOUT_API_URL) always wins --
 *      this is the opt-in for self-hosted or rate-limited instances.
 *   2. Otherwise the selected chain's hosted instance.
 *   3. Otherwise the default Ethereum mainnet instance.
 *
 * Returns an error when a chain is selected that has no known hosted instance
 * and no connection override, rather than silently falling back to Ethereum.
 */
export function resolveInstance(
  credentials: BlockscoutCredentials,
  network?: string | number
): InstanceResolution {
  const override = credentials.BLOCKSCOUT_API_URL?.trim();
  if (override) {
    return { url: override.replace(TRAILING_SLASH_RE, "") };
  }

  const hasNetwork =
    network !== undefined && network !== null && String(network).trim() !== "";
  if (hasNetwork) {
    let chainId: number;
    try {
      chainId = getChainIdFromNetwork(network as string | number);
    } catch {
      return { error: `Unrecognized chain "${network}".` };
    }
    const mapped = BLOCKSCOUT_INSTANCES[chainId];
    if (mapped) {
      return { url: mapped };
    }
    return {
      error: `No hosted Blockscout instance is configured for chain ${chainId}. Add a Blockscout connection with that chain's instance URL.`,
    };
  }

  return { url: DEFAULT_BLOCKSCOUT_API_URL };
}

/**
 * Perform a read-only GET against the Blockscout REST API (v2). Resolves the
 * target instance from the selected chain or connection, appends an optional
 * API key for higher rate limits, and normalizes errors into the
 * discriminated-union result shape used by every step.
 */
export async function blockscoutGet<T>(
  path: string,
  credentials: BlockscoutCredentials,
  network?: string | number
): Promise<BlockscoutFetchResult<T>> {
  const resolved = resolveInstance(credentials, network);
  if ("error" in resolved) {
    return { success: false, error: resolved.error };
  }

  const apiKey = credentials.BLOCKSCOUT_API_KEY?.trim();
  const url = new URL(`${resolved.url}${path}`);
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: "Not found on this Blockscout instance." };
      }
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = (await response.json()) as T;
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: `Failed to reach Blockscout: ${getErrorMessage(error)}`,
    };
  }
}
