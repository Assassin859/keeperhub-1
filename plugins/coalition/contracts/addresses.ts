/**
 * Per-chain Coalition contract addresses.
 * Update after deploying via `pnpm tsx scripts/deploy-coalition.ts --network <chain>`.
 * Chain IDs: 84532 = Base Sepolia, 8453 = Base mainnet.
 */
export const COALITION_ADDRESSES: Record<number, `0x${string}`> = {
  // 84532: "0x0000000000000000000000000000000000000000", // Base Sepolia (paste after deploy)
  // 8453: "0x0000000000000000000000000000000000000000",  // Base mainnet (paste after deploy)
};

export const SUPPORTED_CHAIN_IDS = [84532, 8453] as const;
