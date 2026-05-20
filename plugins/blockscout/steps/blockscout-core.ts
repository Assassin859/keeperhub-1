import "server-only";

import { getErrorMessage } from "@/lib/utils";
import type { BlockscoutCredentials } from "../credentials";

// Default public Blockscout instance (Ethereum mainnet). Users can point at a
// different instance by configuring BLOCKSCOUT_API_URL in Project Integrations.
const DEFAULT_BLOCKSCOUT_API_URL = "https://eth.blockscout.com";

// Strips one or more trailing slashes so paths can be appended consistently.
const TRAILING_SLASH_RE = /\/+$/;

export type BlockscoutFetchResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Resolve the Blockscout instance base URL from credentials, falling back to
 * the public Ethereum mainnet instance. Trailing slashes are stripped so paths
 * can be appended consistently.
 */
export function resolveBaseUrl(credentials: BlockscoutCredentials): string {
  const url = credentials.BLOCKSCOUT_API_URL?.trim() || DEFAULT_BLOCKSCOUT_API_URL;
  return url.replace(TRAILING_SLASH_RE, "");
}

/**
 * Perform a read-only GET against the Blockscout REST API (v2). Appends an
 * optional API key for higher rate limits and normalizes errors into the
 * discriminated-union result shape used by every step.
 */
export async function blockscoutGet<T>(
  path: string,
  credentials: BlockscoutCredentials
): Promise<BlockscoutFetchResult<T>> {
  const baseUrl = resolveBaseUrl(credentials);
  const apiKey = credentials.BLOCKSCOUT_API_KEY?.trim();

  const url = new URL(`${baseUrl}${path}`);
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
