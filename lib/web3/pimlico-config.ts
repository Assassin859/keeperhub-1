import "server-only";
import type { Address } from "viem";
import { SPONSORSHIP_CHAIN_IDS } from "./sponsorship-chains-meta";

function getPimlicoBaseUrl(): string {
  const url = process.env.PIMLICO_BASE_URL;
  if (!url) {
    throw new Error("PIMLICO_BASE_URL not configured");
  }
  return url;
}

export const SUPPORTED_SPONSORSHIP_CHAINS: ReadonlySet<number> =
  SPONSORSHIP_CHAIN_IDS;

export function isSponsorshipSupported(chainId: number): boolean {
  return SUPPORTED_SPONSORSHIP_CHAINS.has(chainId);
}

/**
 * SimpleAccount7702 implementation address for EIP-7702 delegation.
 * Must match the default `accountLogicAddress` in permissionless.js's
 * `toSimpleSmartAccount` -- deployed by Pimlico on all supported chains.
 */
export function getSimpleAccount7702Address(): Address {
  const address = process.env.SIMPLE_ACCOUNT_7702_ADDRESS;
  if (!address) {
    throw new Error("SIMPLE_ACCOUNT_7702_ADDRESS not configured");
  }
  return address as Address;
}

export function getPimlicoUrl(chainId: number): string {
  const apiKey = process.env.PIMLICO_API_KEY;
  if (!apiKey) {
    throw new Error("PIMLICO_API_KEY not configured");
  }
  return `${getPimlicoBaseUrl()}/${chainId}/rpc?apikey=${apiKey}`;
}
