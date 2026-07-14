/**
 * Shared step-level helpers for the Tempo plugin: token resolution, chain
 * validation, and explorer links. Kept out of the "use step" files so both
 * transfer-with-memo and batch-payout can share them.
 */
import "server-only";

import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import type { Hex } from "viem";
import { db } from "@/lib/db";
import { explorerConfigs, supportedTokens } from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { isTempoChain, TEMPO_STABLECOIN_DEX } from "./tempo-tx-core";

const ERC20_META_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

const DEX_QUOTE_ABI = [
  "function quoteSwapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn) view returns (uint128 amountOut)",
] as const;
const dexInterface = new ethers.Interface(DEX_QUOTE_ABI);

export type TempoToken = { address: Hex; decimals: number; symbol: string };

type ParsedTokenConfig = { supportedTokenId?: string; address?: string };

function parseTokenConfig(
  tokenConfig: string | Record<string, unknown> | undefined
): ParsedTokenConfig | null {
  if (!tokenConfig) {
    return null;
  }
  if (typeof tokenConfig === "string") {
    if (tokenConfig.startsWith("0x")) {
      return { address: tokenConfig };
    }
    try {
      return parseTokenConfig(JSON.parse(tokenConfig) as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  const supportedTokenId =
    typeof tokenConfig.supportedTokenId === "string"
      ? tokenConfig.supportedTokenId
      : undefined;
  const custom = tokenConfig.customToken as { address?: string } | undefined;
  const address =
    typeof custom?.address === "string" ? custom.address : undefined;
  return { supportedTokenId, address };
}

async function readTokenMeta(
  rpcManager: RpcProviderManager,
  address: string
): Promise<{ decimals: number; symbol: string }> {
  const [decimals, symbol] = await rpcManager.executeWithFailover((provider) => {
    const contract = new ethers.Contract(address, ERC20_META_ABI, provider);
    return Promise.all([
      contract.decimals() as Promise<bigint>,
      contract.symbol() as Promise<string>,
    ]);
  });
  return { decimals: Number(decimals), symbol };
}

/**
 * Resolve a token-select config value to a concrete Tempo token. Prefers the
 * seeded `supported_tokens` row (address + decimals + symbol in one query) and
 * falls back to reading metadata on-chain for a custom / raw-address token.
 */
export async function resolveTempoToken(
  tokenConfig: string | Record<string, unknown> | undefined,
  chainId: number,
  rpcManager: RpcProviderManager
): Promise<TempoToken> {
  const parsed = parseTokenConfig(tokenConfig);
  if (!parsed) {
    throw new Error("A token is required");
  }

  if (parsed.supportedTokenId) {
    const rows = await db
      .select({
        tokenAddress: supportedTokens.tokenAddress,
        decimals: supportedTokens.decimals,
        symbol: supportedTokens.symbol,
      })
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.id, parsed.supportedTokenId),
          eq(supportedTokens.chainId, chainId)
        )
      )
      .limit(1);
    const row = rows[0];
    if (row && ethers.isAddress(row.tokenAddress)) {
      return {
        address: ethers.getAddress(row.tokenAddress) as Hex,
        decimals: row.decimals,
        symbol: row.symbol,
      };
    }
  }

  if (parsed.address && ethers.isAddress(parsed.address)) {
    const meta = await readTokenMeta(rpcManager, parsed.address);
    return {
      address: ethers.getAddress(parsed.address) as Hex,
      decimals: meta.decimals,
      symbol: meta.symbol,
    };
  }

  throw new Error("Could not resolve the selected token to a contract address");
}

/**
 * Quote a stablecoin-DEX swap: how much `tokenOut` a given `amountIn` of
 * `tokenIn` buys right now. A view call against the enshrined DEX precompile,
 * routed through RPC failover. The caller applies the slippage floor.
 */
export async function quoteTempoSwap(
  rpcManager: RpcProviderManager,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<bigint> {
  const data = dexInterface.encodeFunctionData("quoteSwapExactAmountIn", [
    tokenIn,
    tokenOut,
    amountIn,
  ]);
  const raw = await rpcManager.executeWithFailover((provider) =>
    provider.call({ to: TEMPO_STABLECOIN_DEX, data })
  );
  const [amountOut] = dexInterface.decodeFunctionResult(
    "quoteSwapExactAmountIn",
    raw
  );
  return BigInt(amountOut);
}

export function assertTempoChain(chainId: number): void {
  if (!isTempoChain(chainId)) {
    throw new Error(
      `Chain ${chainId} is not a Tempo network. This action only supports Tempo (4217) and Tempo Testnet (42431).`
    );
  }
}

export async function buildTempoTxLink(
  chainId: number,
  hash: string
): Promise<string> {
  const config = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });
  return config ? getTransactionUrl(config, hash) : "";
}
