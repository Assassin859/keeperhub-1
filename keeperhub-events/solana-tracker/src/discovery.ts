import { KEEPERHUB_API_URL } from "../lib/config/environment";
import type { DiscoveryData, DiscoveryResponse } from "../lib/types";
import { type HmacCaller, signHmacHeaders } from "../lib/utils/fetch-utils";
import { logger } from "../lib/utils/logger";

/**
 * Fetches the Solana slice of both discovery endpoints. The `?chainType=solana`
 * param (added to both routes) makes each endpoint return only Solana-network
 * workflows, so the EVM event-tracker/block-dispatcher keep receiving EVM-only
 * with their default (no param) requests.
 *
 * Event discovery signs as caller "events"; block discovery as "scheduler" -
 * the two callers the existing endpoints already expect.
 */

async function fetchDiscovery(
  path: string,
  caller: HmacCaller,
): Promise<DiscoveryResponse | null> {
  const url = `${KEEPERHUB_API_URL}${path}?active=true&chainType=solana`;
  try {
    const response = await fetch(url, {
      headers: signHmacHeaders("GET", url, "", caller),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as DiscoveryResponse;
  } catch (error) {
    logger.warn(
      `[Discovery] ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function fetchSolanaTriggers(): Promise<DiscoveryData | null> {
  const [events, blocks] = await Promise.all([
    fetchDiscovery("/api/workflows/events", "events"),
    fetchDiscovery("/api/internal/block-workflows", "scheduler"),
  ]);

  // A single failed endpoint must not blank the whole reconcile: if either
  // succeeds we proceed with what we have (the other side keeps its listeners
  // from the previous cycle). Only a total failure returns null.
  if (!events && !blocks) {
    return null;
  }

  // Networks are identical across both endpoints (both return all enabled
  // chains); prefer whichever responded.
  const networks = events?.networks ?? blocks?.networks ?? {};
  return {
    eventWorkflows: events?.workflows ?? [],
    blockWorkflows: blocks?.workflows ?? [],
    networks,
  };
}
