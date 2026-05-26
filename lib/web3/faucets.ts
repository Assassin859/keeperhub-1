import { SUPPORTED_CHAIN_IDS } from "@/lib/rpc/types";

export type TestnetFaucet = {
  chainId: number;
  name: string;
  url: string;
};

// Public faucets for the EVM testnets supported by the platform. Organization
// wallets are EVM addresses, so only EVM testnets are listed here. Used by the
// wallet creation flow to point users at testnet funds (KEEP-493).
export const TESTNET_FAUCETS: TestnetFaucet[] = [
  {
    chainId: SUPPORTED_CHAIN_IDS.SEPOLIA,
    name: "Ethereum Sepolia",
    url: "https://www.alchemy.com/faucets/ethereum-sepolia",
  },
  {
    chainId: SUPPORTED_CHAIN_IDS.BASE_SEPOLIA,
    name: "Base Sepolia",
    url: "https://www.alchemy.com/faucets/base-sepolia",
  },
];
