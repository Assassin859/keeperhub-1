export type SponsorshipChain = {
  chainId: number;
  name: string;
  isTestnet: boolean;
};

export const SPONSORSHIP_CHAINS: readonly SponsorshipChain[] = [
  { chainId: 1, name: "Ethereum", isTestnet: false },
  { chainId: 10, name: "Optimism", isTestnet: false },
  { chainId: 56, name: "BNB Chain", isTestnet: false },
  { chainId: 137, name: "Polygon", isTestnet: false },
  { chainId: 8453, name: "Base", isTestnet: false },
  { chainId: 42_161, name: "Arbitrum One", isTestnet: false },
  { chainId: 97, name: "BNB Testnet", isTestnet: true },
  { chainId: 80_002, name: "Polygon Amoy", isTestnet: true },
  { chainId: 84_532, name: "Base Sepolia", isTestnet: true },
  { chainId: 421_614, name: "Arbitrum Sepolia", isTestnet: true },
  { chainId: 11_155_111, name: "Sepolia", isTestnet: true },
  { chainId: 11_155_420, name: "OP Sepolia", isTestnet: true },
];

export const SPONSORSHIP_CHAIN_IDS: ReadonlySet<number> = new Set(
  SPONSORSHIP_CHAINS.map((c) => c.chainId)
);

export const SPONSORSHIP_MAINNET_NAMES: readonly string[] =
  SPONSORSHIP_CHAINS.filter((c) => !c.isTestnet).map((c) => c.name);

export const SPONSORSHIP_TESTNET_NAMES: readonly string[] =
  SPONSORSHIP_CHAINS.filter((c) => c.isTestnet).map((c) => c.name);
