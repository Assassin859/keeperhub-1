import "server-only";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { type Connection, PublicKey } from "@solana/web3.js";
import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { supportedTokens, workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getSolanaProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { TokenFieldValue } from "@/lib/wallet/types";
import { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import { parseSolanaMintAccount } from "@/lib/web3/solana-mint";
import { validateChainAddress } from "@/lib/web3/validate-chain-address";
import {
  getTokenAddress,
  parseTokenConfig,
  type TokenBalance,
  type TokenConfigSource,
} from "./token-config-core";

const METAPLEX_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
const METADATA_SEED = Buffer.from("metadata");
// Metadata layout before the name field: key (1) + updateAuthority (32) +
// mint (32).
const METADATA_NAME_OFFSET = 65;
const TRAILING_NULLS = /\0+$/;

export type GetSplTokenBalanceCoreInput = TokenConfigSource & {
  network: string;
  address: string;
};

export type GetSplTokenBalanceInput = StepInput & GetSplTokenBalanceCoreInput;

type GetSplTokenBalanceResult =
  | {
      success: true;
      balance: TokenBalance;
      address: string;
      addressLink: string;
    }
  | { success: false; error: string };

/**
 * Get userId from executionId by querying the workflowExecutions table
 */
async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.userId;
}

/**
 * Read a borsh string (u32 LE length prefix + utf8 bytes) at offset,
 * trimming the trailing null padding Metaplex writes inside the declared
 * length. Returns null when the declared length runs past the buffer.
 */
function readBorshString(
  data: Buffer,
  offset: number
): { value: string; nextOffset: number } | null {
  if (offset + 4 > data.length) {
    return null;
  }
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  if (start + length > data.length) {
    return null;
  }
  const value = data
    .subarray(start, start + length)
    .toString("utf8")
    .replace(TRAILING_NULLS, "")
    .trim();
  return { value, nextOffset: start + length };
}

/**
 * Resolve symbol/name from the mint's Metaplex token metadata PDA. Returns
 * null when no metadata account exists or its data does not parse - callers
 * fall back to the unknown-token sentinels.
 */
async function fetchMetaplexDisplayInfo(
  connection: Connection,
  mintPubkey: PublicKey
): Promise<{ symbol: string; name: string } | null> {
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [METADATA_SEED, METAPLEX_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
    METAPLEX_METADATA_PROGRAM_ID
  );

  const accountInfo = await connection.getAccountInfo(
    metadataAddress,
    "confirmed"
  );
  if (!accountInfo) {
    return null;
  }

  const name = readBorshString(accountInfo.data, METADATA_NAME_OFFSET);
  if (!name) {
    return null;
  }
  const symbol = readBorshString(accountInfo.data, name.nextOffset);
  if (!symbol || (!name.value && !symbol.value)) {
    return null;
  }

  return {
    symbol: symbol.value || "???",
    name: name.value || "Unknown",
  };
}

/**
 * Resolve a display symbol/name without touching the chain: the custom-token
 * symbol supplied in tokenConfig, or a matching supportedTokens row. Returns
 * null when neither knows the token, so the caller can try Metaplex metadata.
 */
async function getOffChainDisplayInfo(
  tokenConfig: TokenFieldValue,
  chainId: number,
  tokenAddress: string
): Promise<{ symbol: string; name: string } | null> {
  // "???" is the token-config parser's own unknown-symbol sentinel (see
  // token-config-core.ts) - it is not a real symbol, so it must fall through
  // to the DB lookup rather than short-circuit it.
  if (
    tokenConfig.customToken?.symbol &&
    tokenConfig.customToken.symbol !== "???"
  ) {
    return {
      symbol: tokenConfig.customToken.symbol,
      name: tokenConfig.customToken.symbol,
    };
  }

  const tokens = await db
    .select({ symbol: supportedTokens.symbol, name: supportedTokens.name })
    .from(supportedTokens)
    .where(
      and(
        eq(supportedTokens.chainId, chainId),
        eq(supportedTokens.tokenAddress, tokenAddress)
      )
    )
    .limit(1);

  if (tokens[0]) {
    return { symbol: tokens[0].symbol, name: tokens[0].name };
  }
  return null;
}

/**
 * Fetch an SPL token balance for a wallet. A wallet with no associated
 * token account for this mint has never held the token, which is a zero
 * balance (matching ERC20 balanceOf() on an unfunded holder), not an error.
 */
async function fetchSplBalance(
  connection: Connection,
  walletAddress: string,
  tokenAddress: string
): Promise<{ balanceRaw: bigint; decimals: number; mintPubkey: PublicKey }> {
  const mintPubkey = new PublicKey(tokenAddress);
  const ownerPubkey = new PublicKey(walletAddress);

  const mintInfo = await connection.getAccountInfo(mintPubkey, "confirmed");
  if (!mintInfo) {
    throw new Error(`Mint account not found: ${mintPubkey.toBase58()}`);
  }
  const resolved = parseSolanaMintAccount(mintPubkey, mintInfo);
  if ("error" in resolved) {
    throw new Error(resolved.error);
  }
  const { mint, programId } = resolved;

  // Off-curve owners (PDA/program-owned wallets, e.g. a multisig treasury)
  // are legitimate holders to check - matching transfer-spl-token-core.ts's
  // handling of off-curve recipients. Derivation is synchronous (no RPC).
  const associatedTokenAddress = getAssociatedTokenAddressSync(
    mintPubkey,
    ownerPubkey,
    true,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const accountInfo = await connection.getAccountInfo(
    associatedTokenAddress,
    "confirmed"
  );
  const balanceRaw = accountInfo
    ? unpackAccount(associatedTokenAddress, accountInfo, programId).amount
    : BigInt(0);

  return { balanceRaw, decimals: mint.decimals, mintPubkey };
}

/**
 * Core get SPL token balance logic
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear validation ladder mirroring check-token-balance
async function stepHandler(
  input: GetSplTokenBalanceInput
): Promise<GetSplTokenBalanceResult> {
  const { network, address, _context } = input;
  const tokenConfig = parseTokenConfig(input);

  // Get userId from execution context (for user RPC preferences)
  const userId = await getUserIdFromExecution(_context?.executionId);

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Get SPL Token Balance] Failed to resolve network:",
      error,
      {
        plugin_name: "web3",
        action_name: "get-spl-token-balance",
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  if (!isSolanaChain(chainId)) {
    return {
      success: false,
      error:
        "This action only supports Solana chains. Use the Get ERC20 Token Balance action for EVM tokens.",
    };
  }

  if (!validateChainAddress(address, chainId)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Get SPL Token Balance] Invalid wallet address:",
      address,
      {
        plugin_name: "web3",
        action_name: "get-spl-token-balance",
      }
    );
    return {
      success: false,
      error: `Invalid wallet address: ${address}`,
    };
  }

  const tokenAddress = await getTokenAddress(tokenConfig, chainId);
  if (!tokenAddress) {
    return {
      success: false,
      error: "No token selected to check",
    };
  }

  if (!validateChainAddress(tokenAddress, chainId)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Get SPL Token Balance] Invalid token address:",
      tokenAddress,
      {
        plugin_name: "web3",
        action_name: "get-spl-token-balance",
      }
    );
    return {
      success: false,
      error: `Invalid token address: ${tokenAddress}`,
    };
  }

  // A fresh, userId-aware adapter is constructed directly (bypassing
  // getChainAdapter's chainId-only cache) so a user's custom RPC preference
  // is honored, matching the other Solana steps.
  const adapter = new SolanaChainAdapter(chainId, () =>
    getSolanaProvider({ chainId, userId })
  );

  try {
    const offChainDisplay = await getOffChainDisplayInfo(
      tokenConfig,
      chainId,
      tokenAddress
    );
    const balance = await adapter.executeWithSolanaFailover(
      async (connection) => {
        const { balanceRaw, decimals, mintPubkey } = await fetchSplBalance(
          connection,
          address,
          tokenAddress
        );
        const display =
          offChainDisplay ??
          (await fetchMetaplexDisplayInfo(connection, mintPubkey)) ?? {
            symbol: "???",
            name: "Unknown",
          };
        return {
          balance: ethers.formatUnits(balanceRaw, decimals),
          balanceRaw: balanceRaw.toString(),
          symbol: display.symbol,
          decimals,
          name: display.name,
          tokenAddress,
        };
      }
    );
    const addressLink = await adapter.getAddressUrl(address);

    return { success: true, balance, address, addressLink };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Get SPL Token Balance] Failed to check token balance:",
      error,
      {
        plugin_name: "web3",
        action_name: "get-spl-token-balance",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: `Failed to check token balance: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Get SPL Token Balance Step
 * Checks the SPL token balance of a Solana address for a single mint.
 */
export async function getSplTokenBalanceStep(
  input: GetSplTokenBalanceInput
): Promise<GetSplTokenBalanceResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "get-spl-token-balance",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

getSplTokenBalanceStep.maxRetries = 0;

export const _integrationType = "web3";
