/**
 * Per-chain Coalition contract addresses.
 * Update after deploying via `pnpm tsx scripts/deploy-coalition.ts --network <chain>`.
 * Chain IDs: 84532 = Base Sepolia, 8453 = Base mainnet.
 *
 * Add a chain to SUPPORTED_CHAIN_IDS only after its address is populated in
 * COALITION_ADDRESSES; the two must stay in sync to avoid surfacing a chain
 * the plugin will then reject at runtime.
 */
export const COALITION_ADDRESSES: Record<number, `0x${string}`> = {
  84532: "0x445BE52b852400A8873721947E3BB3A5559CE4d9", // Base Sepolia
};

export const SUPPORTED_CHAIN_IDS = [84532] as const;
