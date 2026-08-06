import "server-only";

import type { ethers } from "ethers";
import {
  describeNativeShortfall,
  getNativeSymbol,
} from "@/lib/execute/native-balance";
import { getRedis } from "@/lib/redis";
import { gasPriceKey, nativeBalanceKey } from "@/lib/redis-keys";
import type { getRpcProvider } from "@/lib/rpc/provider-factory";
import { SIGNER_MODE, type SignerMode } from "@/lib/safe/signer-resolver";

/**
 * Affordability preflight for the direct-signing write paths, run *before* the
 * per-wallet nonce lock is acquired.
 *
 * A wallet that cannot pay must not join the lock queue. It would hold the lock
 * through a full RPC failover round and then fail at broadcast, while every
 * other execution for the same wallet and chain waits behind it. Answering the
 * question first turns that into an immediate, actionable user error.
 *
 * Distinct from the value-only check in `lib/execute/native-balance`: this one
 * asks whether the holder can cover gas at all, which is the case a
 * `write-contract` call with no payable value never otherwise checks.
 */

type RpcManager = Awaited<ReturnType<typeof getRpcProvider>>;

/**
 * Cheapest possible EVM transaction. No call can cost less, so a holder below
 * `value + this floor` provably cannot pay and rejecting it is never a false
 * positive. Deliberately not the call's real gas estimate: that needs a built
 * transaction, and over-estimating here would reject affordable work.
 */
const MIN_TX_GAS_UNITS = BigInt(21_000);

/**
 * Long enough to collapse a burst on one wallet into a few chain reads, short
 * enough that funding the wallet takes effect promptly.
 */
const CACHE_TTL_SECONDS = 10;

export type GasPreflightResult =
  | { affordable: true }
  | { affordable: false; message: string };

/** The address gas is actually drawn from: the Safe in safe modes, else the EOA. */
export function resolveFundingHolder(
  signerMode: SignerMode,
  walletAddress: string
): string {
  return signerMode.kind === SIGNER_MODE.SAFE_ROLE ||
    signerMode.kind === SIGNER_MODE.SAFE
    ? signerMode.safeAddress
    : walletAddress;
}

/** Read-through cache for a chain value. Best-effort: Redis never gates the read. */
async function cachedWeiValue(
  key: string,
  read: () => Promise<bigint>
): Promise<bigint> {
  const redis = getRedis();

  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit !== null) {
        return BigInt(hit);
      }
    } catch {
      // Miss, unreachable, or an unparseable value: fall through to the chain.
    }
  }

  const value = await read();

  if (redis) {
    try {
      await redis.set(key, value.toString(), "EX", CACHE_TTL_SECONDS);
    } catch {
      // A cache write failure must not fail the preflight.
    }
  }

  return value;
}

/**
 * Whether `holderAddress` can cover `valueWei` plus the minimum gas any
 * transaction costs on `chainId`.
 *
 * Fails open on any RPC or lookup error: this is an optimisation ahead of the
 * real send, not an authorisation gate, so a provider blip must not become a
 * user-facing rejection.
 */
export async function preflightGasBalance(input: {
  rpcManager: RpcManager;
  chainId: number;
  holderAddress: string;
  valueWei?: bigint;
}): Promise<GasPreflightResult> {
  const { rpcManager, chainId, holderAddress } = input;
  const valueWei = input.valueWei ?? BigInt(0);

  let balance: bigint;
  let gasPrice: bigint;
  try {
    balance = await cachedWeiValue(
      nativeBalanceKey(chainId, holderAddress),
      () =>
        rpcManager.executeWithFailover(
          (p) => p.getBalance(holderAddress),
          "preflight"
        )
    );
    gasPrice = await cachedWeiValue(gasPriceKey(chainId), async () => {
      const fees: ethers.FeeData = await rpcManager.executeWithFailover(
        (p) => p.getFeeData(),
        "preflight"
      );
      return fees.maxFeePerGas ?? fees.gasPrice ?? BigInt(0);
    });
  } catch {
    return { affordable: true };
  }

  const required = valueWei + MIN_TX_GAS_UNITS * gasPrice;
  if (balance >= required) {
    return { affordable: true };
  }

  const shortfall = describeNativeShortfall({
    symbol: await getNativeSymbol(chainId),
    balance,
    required,
    holder: holderAddress,
  });

  return { affordable: false, message: shortfall.message };
}
