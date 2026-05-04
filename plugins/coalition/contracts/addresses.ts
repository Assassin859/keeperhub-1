/**
 * Per-chain Coalition contract addresses.
 * Update after deploying via `pnpm tsx scripts/deploy-coalition.ts --network <chain>`.
 * Chain IDs: 84532 = Base Sepolia, 8453 = Base mainnet.
 */
export const COALITION_ADDRESSES: Record<number, `0x${string}`> = {
  84532: "0x445BE52b852400A8873721947E3BB3A5559CE4d9", // Base Sepolia
};

export const SUPPORTED_CHAIN_IDS = [84532, 8453] as const;
