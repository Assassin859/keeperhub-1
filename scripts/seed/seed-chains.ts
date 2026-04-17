/**
 * Seed script for default blockchain chains
 *
 * RPC URL resolution priority:
 *   1. CHAIN_RPC_CONFIG JSON (for Helm/AWS Parameter Store)
 *   2. Individual env vars (CHAIN_ETH_MAINNET_PRIMARY_RPC, etc.)
 *   3. Public RPC defaults (no API keys required)
 *
 * Run with: pnpm tsx scripts/seed/seed-chains.ts
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import {
  chains,
  explorerConfigs,
  type NewChain,
  type NewExplorerConfig,
} from "../../lib/db/schema";
import {
  CHAIN_CONFIG,
  getConfigValue,
  getPrivateRpcUrl,
  getRpcUrlByChainId,
  getUsePrivateMempoolRpc,
  getWssUrl,
  parseRpcConfigWithDetails,
} from "../../lib/rpc/rpc-config";

// Parse JSON config from environment (if available) - used for WSS URLs and config values
const rpcConfig = (() => {
  const envValue = process.env.CHAIN_RPC_CONFIG;
  const result = parseRpcConfigWithDetails(envValue);

  if (envValue && Object.keys(result.config).length === 0) {
    console.warn("Failed to parse CHAIN_RPC_CONFIG, using individual env vars");
    if (result.error) {
      console.warn(`  Parse error: ${result.error}`);
    }
    if (result.rawValue) {
      console.warn(`  Raw value (truncated): ${result.rawValue}`);
    }
    console.warn(`  Value length: ${envValue.length} characters`);
    console.warn(
      `  First char code: ${envValue.charCodeAt(0)} (expected 123 for '{')`
    );
  }

  return result.config;
})();

// Helper to get config value with rpcConfig pre-bound
const getChainConfigValue = <T>(
  jsonKey: string,
  field: "chainId" | "symbol" | "isEnabled" | "isTestnet",
  defaultValue: T
): T => getConfigValue(rpcConfig, jsonKey, field, defaultValue);

const DEFAULT_CHAINS: NewChain[] = [
  {
    chainId: getChainConfigValue("eth-mainnet", "chainId", 1),
    name: "Ethereum Mainnet",
    symbol: getChainConfigValue("eth-mainnet", "symbol", "ETH"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(1, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(1, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[1].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[1].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("eth-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("eth-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "eth-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "eth-mainnet" }),
  },
  {
    chainId: getChainConfigValue("eth-sepolia", "chainId", 11_155_111),
    name: "Ethereum Sepolia",
    symbol: getChainConfigValue("eth-sepolia", "symbol", "ETH"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(11_155_111, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(11_155_111, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[11_155_111].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[11_155_111].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("eth-sepolia", "isTestnet", true),
    isEnabled: getChainConfigValue("eth-sepolia", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "eth-sepolia" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "eth-sepolia" }),
  },
  {
    chainId: getChainConfigValue("base-mainnet", "chainId", 8453),
    name: "Base",
    symbol: getChainConfigValue("base-mainnet", "symbol", "BASE"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(8453, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(8453, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[8453].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[8453].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("base-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("base-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "base-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "base-mainnet" }),
  },
  {
    chainId: getChainConfigValue("base-testnet", "chainId", 84_532),
    name: "Base Sepolia",
    symbol: getChainConfigValue("base-testnet", "symbol", "BASE"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(84_532, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(84_532, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[84_532].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[84_532].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("base-testnet", "isTestnet", true),
    isEnabled: getChainConfigValue("base-testnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "base-testnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "base-testnet" }),
  },
  {
    chainId: getChainConfigValue("tempo-testnet", "chainId", 42_429),
    name: "Tempo Testnet",
    symbol: getChainConfigValue("tempo-testnet", "symbol", "TEMPO"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(42_429, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(42_429, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[42_429].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[42_429].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("tempo-testnet", "isTestnet", true),
    isEnabled: getChainConfigValue("tempo-testnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "tempo-testnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "tempo-testnet" }),
  },
  {
    chainId: getChainConfigValue("tempo-mainnet", "chainId", 4217),
    name: "Tempo",
    symbol: getChainConfigValue("tempo-mainnet", "symbol", "TEMPO"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(4217, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(4217, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[4217].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[4217].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("tempo-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("tempo-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "tempo-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "tempo-mainnet" }),
  },
  {
    chainId: getChainConfigValue("bsc-mainnet", "chainId", 56),
    name: "BNB Chain",
    symbol: getChainConfigValue("bsc-mainnet", "symbol", "BNB"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(56, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(56, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[56].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[56].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("bsc-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("bsc-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "bsc-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "bsc-mainnet" }),
  },
  {
    chainId: getChainConfigValue("bsc-testnet", "chainId", 97),
    name: "BNB Chain Testnet",
    symbol: getChainConfigValue("bsc-testnet", "symbol", "BNB"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(97, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(97, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[97].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[97].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("bsc-testnet", "isTestnet", true),
    isEnabled: getChainConfigValue("bsc-testnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "bsc-testnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "bsc-testnet" }),
  },
  {
    chainId: getChainConfigValue("polygon-mainnet", "chainId", 137),
    name: "Polygon",
    symbol: getChainConfigValue("polygon-mainnet", "symbol", "MATIC"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(137, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(137, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[137].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[137].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("polygon-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("polygon-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "polygon-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "polygon-mainnet" }),
  },
  {
    chainId: getChainConfigValue("arbitrum-mainnet", "chainId", 42_161),
    name: "Arbitrum One",
    symbol: getChainConfigValue("arbitrum-mainnet", "symbol", "ETH"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(42_161, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(42_161, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[42_161].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[42_161].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("arbitrum-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("arbitrum-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "arbitrum-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "arbitrum-mainnet" }),
  },
  {
    chainId: getChainConfigValue("polygon-amoy", "chainId", 80_002),
    name: "Polygon Amoy",
    symbol: getChainConfigValue("polygon-amoy", "symbol", "MATIC"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(80_002, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(80_002, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[80_002].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[80_002].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("polygon-amoy", "isTestnet", true),
    isEnabled: getChainConfigValue("polygon-amoy", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "polygon-amoy" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "polygon-amoy" }),
  },
  {
    chainId: getChainConfigValue("arbitrum-sepolia", "chainId", 421_614),
    name: "Arbitrum Sepolia",
    symbol: getChainConfigValue("arbitrum-sepolia", "symbol", "ETH"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(421_614, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(421_614, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[421_614].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[421_614].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("arbitrum-sepolia", "isTestnet", true),
    isEnabled: getChainConfigValue("arbitrum-sepolia", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "arbitrum-sepolia" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "arbitrum-sepolia" }),
  },
  // Avalanche chains
  {
    chainId: getChainConfigValue("avax-mainnet", "chainId", 43_114),
    name: "Avalanche",
    symbol: getChainConfigValue("avax-mainnet", "symbol", "AVAX"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(43_114, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(43_114, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[43_114].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[43_114].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("avax-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("avax-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "avax-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "avax-mainnet" }),
  },
  {
    chainId: getChainConfigValue("avax-fuji", "chainId", 43_113),
    name: "Avalanche Fuji",
    symbol: getChainConfigValue("avax-fuji", "symbol", "AVAX"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(43_113, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(43_113, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[43_113].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[43_113].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("avax-fuji", "isTestnet", true),
    isEnabled: getChainConfigValue("avax-fuji", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "avax-fuji" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "avax-fuji" }),
  },
  // Plasma chains
  {
    chainId: getChainConfigValue("plasma-mainnet", "chainId", 9745),
    name: "Plasma",
    symbol: getChainConfigValue("plasma-mainnet", "symbol", "XPL"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(9745, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(9745, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[9745].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[9745].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("plasma-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("plasma-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "plasma-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "plasma-mainnet" }),
  },
  {
    chainId: getChainConfigValue("plasma-testnet", "chainId", 9746),
    name: "Plasma Testnet",
    symbol: getChainConfigValue("plasma-testnet", "symbol", "XPL"),
    chainType: "evm",
    defaultPrimaryRpc: getRpcUrlByChainId(9746, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(9746, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[9746].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[9746].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("plasma-testnet", "isTestnet", true),
    isEnabled: getChainConfigValue("plasma-testnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "plasma-testnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "plasma-testnet" }),
  },
  // Solana chains (non-EVM - uses SolanaProviderManager)
  {
    chainId: getChainConfigValue("solana-mainnet", "chainId", 101),
    name: "Solana",
    symbol: getChainConfigValue("solana-mainnet", "symbol", "SOL"),
    chainType: "solana",
    defaultPrimaryRpc: getRpcUrlByChainId(101, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(101, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[101].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[101].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("solana-mainnet", "isTestnet", false),
    isEnabled: getChainConfigValue("solana-mainnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "solana-mainnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "solana-mainnet" }),
  },
  {
    chainId: getChainConfigValue("solana-testnet", "chainId", 103),
    name: "Solana Devnet",
    symbol: getChainConfigValue("solana-testnet", "symbol", "SOL"),
    chainType: "solana",
    defaultPrimaryRpc: getRpcUrlByChainId(103, "primary"),
    defaultFallbackRpc: getRpcUrlByChainId(103, "fallback"),
    defaultPrimaryWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[103].jsonKey,
      type: "primary",
    }),
    defaultFallbackWss: getWssUrl({
      rpcConfig,
      jsonKey: CHAIN_CONFIG[103].jsonKey,
      type: "fallback",
    }),
    isTestnet: getChainConfigValue("solana-testnet", "isTestnet", true),
    isEnabled: getChainConfigValue("solana-testnet", "isEnabled", true),
    usePrivateMempoolRpc: getUsePrivateMempoolRpc({ rpcConfig, jsonKey: "solana-testnet" }),
    defaultPrivateRpcUrl: getPrivateRpcUrl({ rpcConfig, jsonKey: "solana-testnet" }),
  },
];

// Explorer configuration template for each chain (KEEP-1154)
// All Etherscan-family chains use the unified V2 API (api.etherscan.io/v2/api)
// with chainid param - one API key covers all chains.
// Note: chainIds are resolved dynamically from DEFAULT_CHAINS to ensure consistency
const EXPLORER_CONFIG_TEMPLATES: Record<
  number,
  Omit<NewExplorerConfig, "chainId">
> = {
  // Ethereum Mainnet - Etherscan V2
  1: {
    chainType: "evm",
    explorerUrl: "https://etherscan.io",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Ethereum Sepolia - Etherscan V2
  11155111: {
    chainType: "evm",
    explorerUrl: "https://sepolia.etherscan.io",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Base Mainnet - Etherscan V2 (Basescan)
  8453: {
    chainType: "evm",
    explorerUrl: "https://basescan.org",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Base Sepolia - Etherscan V2 (Basescan)
  84532: {
    chainType: "evm",
    explorerUrl: "https://sepolia.basescan.org",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Tempo Testnet - Blockscout
  42429: {
    chainType: "evm",
    explorerUrl: "https://explorer.testnet.tempo.xyz",
    explorerApiType: "blockscout",
    explorerApiUrl: "https://explorer.testnet.tempo.xyz/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}?tab=contract",
  },
  // Tempo Mainnet - Blockscout
  4217: {
    chainType: "evm",
    explorerUrl: "https://explore.mainnet.tempo.xyz",
    explorerApiType: "blockscout",
    explorerApiUrl: "https://explore.mainnet.tempo.xyz/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}?tab=contract",
  },
  // BNB Chain Mainnet - Etherscan V2 (BscScan)
  56: {
    chainType: "evm",
    explorerUrl: "https://bscscan.com",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // BNB Chain Testnet - Etherscan V2 (BscScan)
  97: {
    chainType: "evm",
    explorerUrl: "https://testnet.bscscan.com",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Polygon Mainnet - Etherscan V2 (Polygonscan)
  137: {
    chainType: "evm",
    explorerUrl: "https://polygonscan.com",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Arbitrum One - Etherscan V2 (Arbiscan)
  42161: {
    chainType: "evm",
    explorerUrl: "https://arbiscan.io",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Polygon Amoy - Etherscan V2 (Polygonscan)
  80002: {
    chainType: "evm",
    explorerUrl: "https://amoy.polygonscan.com",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Arbitrum Sepolia - Etherscan V2 (Arbiscan)
  421614: {
    chainType: "evm",
    explorerUrl: "https://sepolia.arbiscan.io",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Avalanche C-Chain - Etherscan V2 (Snowtrace)
  43114: {
    chainType: "evm",
    explorerUrl: "https://snowtrace.io",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Avalanche Fuji - Etherscan V2 (Snowtrace)
  43113: {
    chainType: "evm",
    explorerUrl: "https://testnet.snowtrace.io",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Plasma Mainnet - Etherscan V2 (Plasmascan)
  9745: {
    chainType: "evm",
    explorerUrl: "https://plasmascan.to",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Plasma Testnet - Etherscan V2 (Plasmascan)
  9746: {
    chainType: "evm",
    explorerUrl: "https://testnet.plasmascan.to",
    explorerApiType: "etherscan",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/address/{address}",
    explorerContractPath: "/address/{address}#code",
  },
  // Solana Mainnet - Solscan
  101: {
    chainType: "solana",
    explorerUrl: "https://solscan.io",
    explorerApiType: "solscan",
    explorerApiUrl: "https://api.solscan.io",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/account/{address}",
    explorerContractPath: "/account/{address}#anchorProgramIDL",
  },
  // Solana Devnet - Solscan
  103: {
    chainType: "solana",
    explorerUrl: "https://solscan.io/?cluster=devnet",
    explorerApiType: "solscan",
    explorerApiUrl: "https://api-devnet.solscan.io",
    explorerTxPath: "/tx/{hash}",
    explorerAddressPath: "/account/{address}",
    explorerContractPath: "/account/{address}#anchorProgramIDL",
  },
};

async function seedChains() {
  const connectionString = getDatabaseUrl();

  console.log("Connecting to database...");
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  console.log(`Seeding ${DEFAULT_CHAINS.length} chains...`);

  for (const chain of DEFAULT_CHAINS) {
    // Check if chain already exists
    const existing = await db
      .select()
      .from(chains)
      .where(eq(chains.chainId, chain.chainId))
      .limit(1);

    if (existing.length > 0) {
      // Update existing chain with new values (except id and timestamps)
      // Note: Use ?? null to ensure undefined values are explicitly set to null,
      // otherwise Drizzle skips undefined fields in UPDATE statements
      await db
        .update(chains)
        .set({
          name: chain.name,
          symbol: chain.symbol,
          chainType: chain.chainType,
          defaultPrimaryRpc: chain.defaultPrimaryRpc,
          defaultFallbackRpc: chain.defaultFallbackRpc ?? null,
          defaultPrimaryWss: chain.defaultPrimaryWss ?? null,
          defaultFallbackWss: chain.defaultFallbackWss ?? null,
          usePrivateMempoolRpc: chain.usePrivateMempoolRpc ?? false,
          defaultPrivateRpcUrl: chain.defaultPrivateRpcUrl ?? null,
          isTestnet: chain.isTestnet,
          isEnabled: chain.isEnabled,
          updatedAt: new Date(),
        })
        .where(eq(chains.chainId, chain.chainId));
      console.log(`  ~ ${chain.name} (${chain.chainId}) updated`);
      continue;
    }

    await db.insert(chains).values(chain);
    console.log(`  + ${chain.name} (${chain.chainId}) inserted`);
  }

  // Build EXPLORER_CONFIGS dynamically using resolved chainIds from DEFAULT_CHAINS
  // This ensures chainId consistency between chains and explorer configs
  // We map each chain to its explorer config using the CHAIN_CONFIG to find the default chainId
  const chainToDefaultIdMap: Record<string, number> = {
    "Ethereum Mainnet": 1,
    "Ethereum Sepolia": 11_155_111,
    Base: 8453,
    "Base Sepolia": 84_532,
    "Tempo Testnet": 42_429,
    Tempo: 4217,
    "BNB Chain": 56,
    "BNB Chain Testnet": 97,
    Polygon: 137,
    "Arbitrum One": 42_161,
    "Polygon Amoy": 80_002,
    "Arbitrum Sepolia": 421_614,
    Avalanche: 43_114,
    "Avalanche Fuji": 43_113,
    Plasma: 9745,
    "Plasma Testnet": 9746,
    Solana: 101,
    "Solana Devnet": 103,
  };

  const EXPLORER_CONFIGS: NewExplorerConfig[] = DEFAULT_CHAINS.map((chain) => {
    // Look up the default chainId using the chain name
    const defaultChainId = chainToDefaultIdMap[chain.name];

    if (!(defaultChainId && EXPLORER_CONFIG_TEMPLATES[defaultChainId])) {
      console.warn(
        `  ! No explorer config template for chain ${chain.name} (${chain.chainId}), skipping`
      );
      return null;
    }

    const template = EXPLORER_CONFIG_TEMPLATES[defaultChainId];
    return {
      chainId: chain.chainId, // Use the resolved chainId from the chain
      ...template,
    };
  }).filter((config): config is NewExplorerConfig => config !== null);

  console.log(`\nSeeding ${EXPLORER_CONFIGS.length} explorer configs...`);

  for (const config of EXPLORER_CONFIGS) {
    // Check if explorer config already exists for this chain
    const existing = await db
      .select()
      .from(explorerConfigs)
      .where(eq(explorerConfigs.chainId, config.chainId))
      .limit(1);

    if (existing.length > 0) {
      // Update existing explorer config with new values (except id and timestamps)
      await db
        .update(explorerConfigs)
        .set({
          chainType: config.chainType,
          explorerUrl: config.explorerUrl,
          explorerApiType: config.explorerApiType,
          explorerApiUrl: config.explorerApiUrl,
          explorerTxPath: config.explorerTxPath,
          explorerAddressPath: config.explorerAddressPath,
          explorerContractPath: config.explorerContractPath,
          updatedAt: new Date(),
        })
        .where(eq(explorerConfigs.chainId, config.chainId));
      console.log(
        `  ~ Explorer config for chain ${config.chainId} (${config.explorerApiType}) updated`
      );
      continue;
    }

    await db.insert(explorerConfigs).values(config);
    console.log(
      `  + Explorer config for chain ${config.chainId} (${config.explorerApiType}) inserted`
    );
  }

  console.log("\nDone!");
  await client.end();
  process.exit(0);
}

seedChains().catch((err) => {
  console.error("Error seeding chains:", err);
  process.exit(1);
});
