/**
 * Native-gas + ERC20-balance preflights for protocol-coverage tests (KEEP-458).
 *
 * The setup workflow itself can't fund the wallet that signs its own
 * transactions, so this helper runs as a TS preflight in `beforeAll`. Logic is
 * lifted from `scripts/miscellaneous/fund-test-wallet.ts:84-126` and
 * parameterised on chainId so it works across testnets.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { ethers } from "ethers";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/db/connection-utils";
import { chains } from "@/lib/db/schema";
import {
  FUND_NATIVE_AMOUNT_WEI_BY_CHAIN,
  MIN_NATIVE_BALANCE_WEI_BY_CHAIN,
  TESTNET_FUNDER_PK_ENV,
} from "@/lib/test-data/chain-test-data";

const ERC20_BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

async function getChainRpcUrl(chainId: string): Promise<string> {
  const client = postgres(getDatabaseUrl(), { max: 1 });
  try {
    const db = drizzle(client);
    const [row] = await db
      .select({ rpc: chains.defaultPrimaryRpc })
      .from(chains)
      .where(eq(chains.chainId, Number(chainId)))
      .limit(1);
    if (!row?.rpc) {
      throw new Error(`No RPC URL configured for chain ${chainId} in DB`);
    }
    return row.rpc;
  } finally {
    await client.end();
  }
}

/**
 * Top up the test wallet on `chainId` with native gas if its balance falls
 * below the chain's minimum. Throws when the funder isn't configured.
 */
export async function ensureNativeGas(
  chainId: string,
  address: string
): Promise<void> {
  const minWei = MIN_NATIVE_BALANCE_WEI_BY_CHAIN[chainId];
  const topUpWei = FUND_NATIVE_AMOUNT_WEI_BY_CHAIN[chainId];
  if (minWei === undefined || topUpWei === undefined) {
    throw new Error(
      `chain ${chainId} missing entry in MIN_NATIVE_BALANCE_WEI_BY_CHAIN / FUND_NATIVE_AMOUNT_WEI_BY_CHAIN (lib/test-data/chain-test-data.ts)`
    );
  }

  const funderPk = process.env[TESTNET_FUNDER_PK_ENV];
  if (!funderPk) {
    throw new Error(
      `${TESTNET_FUNDER_PK_ENV} not set; cannot top up native gas on chain ${chainId}`
    );
  }

  const rpcUrl = await getChainRpcUrl(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const balance = await provider.getBalance(address);
  if (balance >= minWei) {
    return;
  }

  const funder = new ethers.Wallet(funderPk, provider);
  const funderBalance = await provider.getBalance(funder.address);
  if (funderBalance < topUpWei) {
    throw new Error(
      `funder ${funder.address} has ${ethers.formatEther(funderBalance)} on chain ${chainId}; need >= ${ethers.formatEther(topUpWei)}`
    );
  }
  const tx = await funder.sendTransaction({ to: address, value: topUpWei });
  await tx.wait();
}

/**
 * Assert the wallet holds at least `minHuman` of `token` on `chainId`. Throws
 * with a clear "manual provisioning required" message when it doesn't.
 *
 * Phase 1 does not attempt to acquire ERC20s automatically — see
 * `lib/test-data/chain-test-data.ts::FAUCETS` comment.
 */
export async function ensureErc20Balance(
  chainId: string,
  address: string,
  tokenAddress: string,
  decimals: number,
  minHuman: string,
  symbol: string
): Promise<void> {
  const rpcUrl = await getChainRpcUrl(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const token = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);
  const balance: bigint = await token.balanceOf(address);
  const minWei = ethers.parseUnits(minHuman, decimals);
  if (balance >= minWei) {
    return;
  }
  throw new Error(
    `manual provisioning required: wallet ${address} holds ${ethers.formatUnits(balance, decimals)} ${symbol} on chain ${chainId}; need >= ${minHuman}. Acquire via faucet/transfer then retry.`
  );
}
