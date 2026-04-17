/**
 * RPC URL configuration utilities
 *
 * RPC URL resolution priority:
 *   1. CHAIN_RPC_CONFIG JSON (for Helm/AWS Parameter Store)
 *   2. Individual env vars (CHAIN_ETH_MAINNET_PRIMARY_RPC, etc.)
 *   3. Public RPC defaults (no API keys required)
 *
 * JSON config format (CHAIN_RPC_CONFIG from AWS Parameter Store):
 *   {
 *     "eth-mainnet": {
 *       "chainId": 1,
 *       "symbol": "ETH",
 *       "primaryRpcUrl": "https://...",
 *       "fallbackRpcUrl": "https://...",
 *       "primaryWssUrl": "wss://...",
 *       "fallbackWssUrl": "wss://...",
 *       "isEnabled": true,
 *       "isTestnet": false
 *     }
 *   }
 */

/**
 * Public RPC defaults (no API keys required)
 * These are used as last resort when no config is provided
 */
export const PUBLIC_RPCS = {
  ETH_MAINNET: "https://chain.techops.services/eth-mainnet",
  ETH_MAINNET_FALLBACK: "https://1rpc.io/eth",
  SEPOLIA: "https://ethereum-sepolia-rpc.publicnode.com",
  BASE_MAINNET: "https://mainnet.base.org",
  BASE_SEPOLIA: "https://sepolia.base.org",
  TEMPO_TESTNET: "https://rpc.testnet.tempo.xyz",
  TEMPO_MAINNET: "https://rpc.tempo.xyz",
  BSC_MAINNET: "https://bsc-dataseed.binance.org",
  BSC_MAINNET_FALLBACK: "https://rpc.ankr.com/bsc",
  BSC_TESTNET: "https://bsc-testnet-rpc.publicnode.com",
  BSC_TESTNET_FALLBACK: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  POLYGON_MAINNET: "https://polygon-bor-rpc.publicnode.com",
  POLYGON_MAINNET_FALLBACK: "https://rpc.ankr.com/polygon",
  POLYGON_AMOY: "https://rpc-amoy.polygon.technology",
  POLYGON_AMOY_FALLBACK: "https://polygon-amoy-bor-rpc.publicnode.com",
  ARBITRUM_MAINNET: "https://arb1.arbitrum.io/rpc",
  ARBITRUM_MAINNET_FALLBACK: "https://rpc.ankr.com/arbitrum",
  ARBITRUM_SEPOLIA: "https://sepolia-rollup.arbitrum.io/rpc",
  ARBITRUM_SEPOLIA_FALLBACK: "https://arbitrum-sepolia-rpc.publicnode.com",
  AVAX_MAINNET: "https://api.avax.network/ext/bc/C/rpc",
  AVAX_MAINNET_FALLBACK: "https://avalanche-c-chain-rpc.publicnode.com",
  AVAX_FUJI: "https://api.avax-test.network/ext/bc/C/rpc",
  AVAX_FUJI_FALLBACK: "https://avalanche-fuji-c-chain-rpc.publicnode.com",
  PLASMA_MAINNET: "https://rpc.plasma.to",
  PLASMA_MAINNET_FALLBACK: "https://plasma.drpc.org",
  PLASMA_TESTNET: "https://testnet-rpc.plasma.to",
  PLASMA_TESTNET_FALLBACK: "https://9746.rpc.thirdweb.com",
  SOLANA_MAINNET: "https://api.mainnet-beta.solana.com",
  SOLANA_DEVNET: "https://api.devnet.solana.com",
} as const;

/**
 * Chain configuration mapping - single source of truth for chain ID to config key mapping
 */
export type ChainConfigEntry = {
  jsonKey: string;
  envKey: string;
  fallbackEnvKey: string;
  publicDefault: string;
  publicFallback?: string;
};

export const CHAIN_CONFIG: Record<number, ChainConfigEntry> = {
  // Ethereum Mainnet
  1: {
    jsonKey: "eth-mainnet",
    envKey: "CHAIN_ETH_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_ETH_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.ETH_MAINNET,
    publicFallback: PUBLIC_RPCS.ETH_MAINNET_FALLBACK,
  },
  // Sepolia Testnet
  11155111: {
    jsonKey: "eth-sepolia",
    envKey: "CHAIN_SEPOLIA_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_SEPOLIA_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.SEPOLIA,
  },
  // Base Mainnet
  8453: {
    jsonKey: "base-mainnet",
    envKey: "CHAIN_BASE_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_BASE_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.BASE_MAINNET,
  },
  // Base Sepolia
  84532: {
    jsonKey: "base-testnet",
    envKey: "CHAIN_BASE_SEPOLIA_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_BASE_SEPOLIA_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.BASE_SEPOLIA,
  },
  // Tempo Testnet
  42429: {
    jsonKey: "tempo-testnet",
    envKey: "CHAIN_TEMPO_TESTNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_TEMPO_TESTNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.TEMPO_TESTNET,
  },
  // Tempo Mainnet (4217 is the canonical chain ID; 42420 kept for backwards compatibility)
  4217: {
    jsonKey: "tempo-mainnet",
    envKey: "CHAIN_TEMPO_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_TEMPO_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.TEMPO_MAINNET,
  },
  42420: {
    jsonKey: "tempo-mainnet",
    envKey: "CHAIN_TEMPO_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_TEMPO_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.TEMPO_MAINNET,
  },
  // BNB Chain (BSC) Mainnet
  56: {
    jsonKey: "bsc-mainnet",
    envKey: "CHAIN_BSC_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_BSC_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.BSC_MAINNET,
    publicFallback: PUBLIC_RPCS.BSC_MAINNET_FALLBACK,
  },
  // BNB Chain (BSC) Testnet
  97: {
    jsonKey: "bsc-testnet",
    envKey: "CHAIN_BSC_TESTNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_BSC_TESTNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.BSC_TESTNET,
    publicFallback: PUBLIC_RPCS.BSC_TESTNET_FALLBACK,
  },
  // Polygon Mainnet
  137: {
    jsonKey: "polygon-mainnet",
    envKey: "CHAIN_POLYGON_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_POLYGON_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.POLYGON_MAINNET,
    publicFallback: PUBLIC_RPCS.POLYGON_MAINNET_FALLBACK,
  },
  // Polygon Amoy Testnet
  80002: {
    jsonKey: "polygon-amoy",
    envKey: "CHAIN_POLYGON_AMOY_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_POLYGON_AMOY_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.POLYGON_AMOY,
    publicFallback: PUBLIC_RPCS.POLYGON_AMOY_FALLBACK,
  },
  // Arbitrum One
  42161: {
    jsonKey: "arbitrum-mainnet",
    envKey: "CHAIN_ARBITRUM_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_ARBITRUM_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.ARBITRUM_MAINNET,
    publicFallback: PUBLIC_RPCS.ARBITRUM_MAINNET_FALLBACK,
  },
  // Arbitrum Sepolia
  421614: {
    jsonKey: "arbitrum-sepolia",
    envKey: "CHAIN_ARBITRUM_SEPOLIA_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_ARBITRUM_SEPOLIA_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.ARBITRUM_SEPOLIA,
    publicFallback: PUBLIC_RPCS.ARBITRUM_SEPOLIA_FALLBACK,
  },
  // Avalanche C-Chain
  43114: {
    jsonKey: "avax-mainnet",
    envKey: "CHAIN_AVAX_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_AVAX_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.AVAX_MAINNET,
    publicFallback: PUBLIC_RPCS.AVAX_MAINNET_FALLBACK,
  },
  // Avalanche Fuji Testnet
  43113: {
    jsonKey: "avax-fuji",
    envKey: "CHAIN_AVAX_FUJI_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_AVAX_FUJI_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.AVAX_FUJI,
    publicFallback: PUBLIC_RPCS.AVAX_FUJI_FALLBACK,
  },
  // Plasma Mainnet
  9745: {
    jsonKey: "plasma-mainnet",
    envKey: "CHAIN_PLASMA_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_PLASMA_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.PLASMA_MAINNET,
    publicFallback: PUBLIC_RPCS.PLASMA_MAINNET_FALLBACK,
  },
  // Plasma Testnet
  9746: {
    jsonKey: "plasma-testnet",
    envKey: "CHAIN_PLASMA_TESTNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_PLASMA_TESTNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.PLASMA_TESTNET,
    publicFallback: PUBLIC_RPCS.PLASMA_TESTNET_FALLBACK,
  },
  // Solana Mainnet
  101: {
    jsonKey: "solana-mainnet",
    envKey: "CHAIN_SOLANA_MAINNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_SOLANA_MAINNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.SOLANA_MAINNET,
  },
  // Solana Devnet
  103: {
    jsonKey: "solana-testnet",
    envKey: "CHAIN_SOLANA_DEVNET_PRIMARY_RPC",
    fallbackEnvKey: "CHAIN_SOLANA_DEVNET_FALLBACK_RPC",
    publicDefault: PUBLIC_RPCS.SOLANA_DEVNET,
  },
};

/**
 * Lazy-initialized RPC config singleton
 * Parses CHAIN_RPC_CONFIG from environment once on first access
 */
let _rpcConfigSingleton: RpcConfig = {};

function getRpcConfigSingleton(): RpcConfig {
  if (Object.keys(_rpcConfigSingleton).length === 0) {
    const envValue = process.env.CHAIN_RPC_CONFIG;
    const result = parseRpcConfigWithDetails(envValue);

    if (envValue && Object.keys(result.config).length === 0) {
      console.warn(
        "[rpc-config] Failed to parse CHAIN_RPC_CONFIG, using public RPC defaults"
      );
      if (result.error) {
        console.warn(`  Parse error: ${result.error}`);
      }
    }

    _rpcConfigSingleton = result.config;
  }
  return _rpcConfigSingleton;
}

/**
 * Get RPC URL by chain ID - simple convenience function for scripts
 *
 * Uses CHAIN_RPC_CONFIG from environment if available, falls back to public RPCs.
 *
 * @param chainId - The chain ID (e.g., 1 for Ethereum mainnet)
 * @param type - "primary" or "fallback"
 * @returns The resolved RPC URL
 * @throws Error if chain ID is not configured
 */
export function getRpcUrlByChainId(
  chainId: number,
  type: "primary" | "fallback" = "primary"
): string {
  const config = CHAIN_CONFIG[chainId];
  if (!config) {
    throw new Error(`No RPC configuration for chain ID ${chainId}`);
  }

  const rpcConfig = getRpcConfigSingleton();
  const envKey = type === "primary" ? config.envKey : config.fallbackEnvKey;
  const publicDefault =
    type === "fallback" && config.publicFallback
      ? config.publicFallback
      : config.publicDefault;

  return getRpcUrl({
    rpcConfig,
    jsonKey: config.jsonKey,
    envValue: process.env[envKey],
    publicDefault,
    type,
  });
}

/**
 * Get the chain config entry for a chain ID
 * Useful when you need access to the jsonKey or env var names
 */
export function getChainConfig(chainId: number): ChainConfigEntry | undefined {
  return CHAIN_CONFIG[chainId];
}

/**
 * Type for RPC configuration entry
 */
export type RpcConfigEntry = {
  chainId?: number;
  symbol?: string;
  primaryRpcUrl?: string;
  fallbackRpcUrl?: string;
  primaryWssUrl?: string;
  fallbackWssUrl?: string;
  isPrivateMempoolRpcEnabled?: boolean;
  privateMempoolRpcUrl?: string;
  isEnabled?: boolean;
  isTestnet?: boolean;
};

/**
 * Type for RPC configuration object
 */
export type RpcConfig = Record<string, RpcConfigEntry>;

/**
 * Options for getRpcUrl function
 */
export type GetRpcUrlOptions = {
  rpcConfig: RpcConfig;
  jsonKey: string;
  envValue: string | undefined;
  publicDefault: string;
  type: "primary" | "fallback";
};

/**
 * Result type for parseRpcConfig with error details
 */
export type ParseRpcConfigResult = {
  config: RpcConfig;
  error?: string;
  rawValue?: string;
};

/**
 * Parse JSON config from environment variable
 *
 * @param envValue - The CHAIN_RPC_CONFIG environment variable value
 * @returns Parsed RPC config object, or empty object on failure
 */
export function parseRpcConfig(envValue: string | undefined): RpcConfig {
  try {
    return JSON.parse(envValue || "{}");
  } catch {
    return {};
  }
}

/**
 * Parse JSON config with detailed error information for debugging
 *
 * @param envValue - The CHAIN_RPC_CONFIG environment variable value
 * @returns Object containing parsed config and any error details
 */
export function parseRpcConfigWithDetails(
  envValue: string | undefined
): ParseRpcConfigResult {
  if (!envValue) {
    return { config: {} };
  }

  try {
    const config = JSON.parse(envValue);
    return { config };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Truncate raw value for logging (may contain sensitive URLs)
    const rawValue =
      envValue.length > 100 ? `${envValue.slice(0, 100)}...` : envValue;
    return { config: {}, error, rawValue };
  }
}

/**
 * Get RPC URL with priority: JSON config → individual env var → public default
 *
 * @param options - Configuration options
 * @returns The resolved RPC URL
 */
export function getRpcUrl(options: GetRpcUrlOptions): string {
  const { rpcConfig, jsonKey, envValue, publicDefault, type } = options;
  const entry = rpcConfig[jsonKey];

  if (!entry) {
    return envValue || publicDefault;
  }

  if (type === "primary" && entry.primaryRpcUrl) {
    return entry.primaryRpcUrl;
  }
  if (type === "fallback" && entry.fallbackRpcUrl) {
    return entry.fallbackRpcUrl;
  }

  return envValue || publicDefault;
}

/**
 * Options for getWssUrl function
 */
export type GetWssUrlOptions = {
  rpcConfig: RpcConfig;
  jsonKey: string;
  type: "primary" | "fallback";
};

/**
 * Get WebSocket URL from JSON config (new schema only)
 *
 * @param options - Configuration options
 * @returns The resolved WSS URL, or undefined if not configured
 */
export function getWssUrl(options: GetWssUrlOptions): string | undefined {
  const { rpcConfig, jsonKey, type } = options;
  const entry = rpcConfig[jsonKey];

  if (!entry) {
    return;
  }

  if (type === "primary") {
    return entry.primaryWssUrl;
  }
  return entry.fallbackWssUrl;
}

/**
 * Options for getPrivateRpcUrl / getUsePrivateMempoolRpc
 */
export type GetPrivateMempoolOptions = {
  rpcConfig: RpcConfig;
  jsonKey: string;
};

/**
 * Get the private mempool RPC URL from chain-config JSON.
 *
 * No env-var fallback: private mempool endpoints are only configured via
 * chain-config JSON (flows in through CHAIN_RPC_CONFIG at deploy time).
 *
 * @returns The private RPC URL, or undefined if not configured
 */
export function getPrivateRpcUrl(
  options: GetPrivateMempoolOptions
): string | undefined {
  return options.rpcConfig[options.jsonKey]?.privateMempoolRpcUrl;
}

/**
 * Get whether the chain has private mempool routing enabled.
 *
 * Defaults to false when not set in chain-config JSON.
 */
export function getUsePrivateMempoolRpc(
  options: GetPrivateMempoolOptions
): boolean {
  return options.rpcConfig[options.jsonKey]?.isPrivateMempoolRpcEnabled ?? false;
}

/**
 * Get a config value from RPC config with fallback to default
 *
 * @param rpcConfig - The parsed RPC config object
 * @param jsonKey - The chain key (e.g., "eth-mainnet", "base-mainnet")
 * @param field - The field to retrieve (e.g., "symbol", "chainId", "isEnabled")
 * @param defaultValue - Default value if not found in config
 * @returns The config value or default
 */
export function getConfigValue<T>(
  rpcConfig: RpcConfig,
  jsonKey: string,
  field: keyof RpcConfigEntry,
  defaultValue: T
): T {
  const entry = rpcConfig[jsonKey];
  if (entry && field in entry && entry[field] !== undefined) {
    return entry[field] as T;
  }
  return defaultValue;
}

/**
 * Create a pre-configured getRpcUrl helper using process.env
 *
 * This is a convenience function for scripts that need to resolve RPC URLs
 * using the standard environment variable pattern.
 *
 * @param rpcConfig - Pre-parsed RPC config (from parseRpcConfig)
 * @returns A function that resolves RPC URLs for a given chain
 */
export function createRpcUrlResolver(rpcConfig: RpcConfig) {
  return function resolveRpcUrl(
    jsonKey: string,
    envKey: string,
    publicDefault: string,
    type: "primary" | "fallback"
  ): string {
    return getRpcUrl({
      rpcConfig,
      jsonKey,
      envValue: process.env[envKey],
      publicDefault,
      type,
    });
  };
}
