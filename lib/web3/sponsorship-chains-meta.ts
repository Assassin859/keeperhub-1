export type SponsorshipChain = {
  chainId: number;
  name: string;
  isTestnet: boolean;
};

// Chains where Turnkey's native Transaction Management (Gas Station) can sign
// and sponsor a transaction. This is the single source of truth shared by the
// runtime sponsorship preflight and the billing UI, so the two cannot drift.
// Turnkey supports four mainnets and their canonical testnets; Optimism and
// BNB are intentionally absent because the Gas Station does not cover them.
export const SPONSORSHIP_CHAINS: readonly SponsorshipChain[] = [
  { chainId: 1, name: "Ethereum", isTestnet: false },
  { chainId: 137, name: "Polygon", isTestnet: false },
  { chainId: 8453, name: "Base", isTestnet: false },
  { chainId: 42_161, name: "Arbitrum", isTestnet: false },
  { chainId: 11_155_111, name: "Ethereum Sepolia", isTestnet: true },
  { chainId: 80_002, name: "Polygon Amoy", isTestnet: true },
  { chainId: 84_532, name: "Base Sepolia", isTestnet: true },
  { chainId: 421_614, name: "Arbitrum Sepolia", isTestnet: true },
];

export const SPONSORSHIP_CHAIN_IDS: ReadonlySet<number> = new Set(
  SPONSORSHIP_CHAINS.map((c) => c.chainId)
);

export const SPONSORSHIP_MAINNET_NAMES: readonly string[] =
  SPONSORSHIP_CHAINS.filter((c) => !c.isTestnet).map((c) => c.name);

export const SPONSORSHIP_TESTNET_NAMES: readonly string[] =
  SPONSORSHIP_CHAINS.filter((c) => c.isTestnet).map((c) => c.name);
