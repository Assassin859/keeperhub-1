import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { ethers } from "ethers";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { getTokenInfo } from "@/lib/contracts/tokens";
import { db } from "@/lib/db";
import {
  type SafeModuleInstallation,
  type SafeTokenLimit,
  type SafeWallet,
  safeModuleInstallations,
  safeTokenLimits,
  safeWallets,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getOrganizationWallet,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import {
  ALLOWANCE_MODULE_ABI,
  buildAddDelegateCalldata,
  buildDeleteAllowanceCalldata,
  buildEnableModuleCalldata,
  buildExecTransactionCalldata,
  buildSetAllowanceCalldata,
  decodeTokenAllowance,
} from "@/lib/safe/allowance-module";
import {
  getAllowanceModuleAddress,
  isSafeSupportedChain,
} from "@/lib/safe/contracts";
import { generateId } from "@/lib/utils/id";
import {
  executeTransaction,
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

const MODULE_TYPE_ALLOWANCE = "allowance" as const;

export type AllowanceInstallationResult =
  | {
      success: true;
      installation: SafeModuleInstallation;
      alreadyInstalled: boolean;
    }
  | { success: false; error: string };

export type SetTokenAllowanceInput = {
  organizationId: string;
  chainId: number;
  tokenAddress: string;
  amountWei: string;
  periodMinutes: number;
};

export type SetTokenAllowanceResult =
  | { success: true; limit: SafeTokenLimit }
  | { success: false; error: string };

export type RevokeTokenAllowanceInput = {
  organizationId: string;
  chainId: number;
  tokenAddress: string;
};

export type RevokeTokenAllowanceResult =
  | { success: true; deleted: SafeTokenLimit }
  | { success: false; error: string };

async function findSafeForOrg(
  organizationId: string,
  chainId: number
): Promise<SafeWallet | null> {
  const rows = await db
    .select()
    .from(safeWallets)
    .where(
      and(
        eq(safeWallets.organizationId, organizationId),
        eq(safeWallets.chainId, chainId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

async function findInstallation(
  safeWalletId: string,
  moduleType: string = MODULE_TYPE_ALLOWANCE
): Promise<SafeModuleInstallation | null> {
  const rows = await db
    .select()
    .from(safeModuleInstallations)
    .where(
      and(
        eq(safeModuleInstallations.safeWalletId, safeWalletId),
        eq(safeModuleInstallations.moduleType, moduleType)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

function buildTxContext(options: {
  organizationId: string;
  chainId: number;
  executionId: string;
}): {
  context: TransactionContext;
  rpcUrl: string;
} {
  const rpcUrl = getRpcUrlByChainId(options.chainId, "primary");
  const context: TransactionContext = {
    organizationId: options.organizationId,
    executionId: options.executionId,
    chainId: options.chainId,
    rpcUrl,
    triggerType: "manual",
  };
  return { context, rpcUrl };
}

/**
 * Enable Safe's Allowance Module on the org's Safe for the given chain and
 * register the Turnkey EOA (the Safe's owner) as the spending delegate.
 *
 * Idempotent: if the DB row already exists the call is a no-op. On-chain we
 * assume if the DB says "enabled" it's enabled; if recovery is needed (DB
 * out of sync with chain) the caller should reconcile via the read-only
 * `is-module-enabled` protocol action.
 */
export async function installAllowanceModule(options: {
  organizationId: string;
  chainId: number;
}): Promise<AllowanceInstallationResult> {
  const { organizationId, chainId } = options;

  if (!isSafeSupportedChain(chainId)) {
    return {
      success: false,
      error: `Chain ${chainId} does not have Safe Allowance Module support`,
    };
  }

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return {
      success: false,
      error: "Deploy a Safe on this chain before enabling spending limits",
    };
  }
  if (safe.status !== "deployed") {
    return {
      success: false,
      error: `Safe is not yet deployed (status: ${safe.status})`,
    };
  }

  const existing = await findInstallation(safe.id);
  if (existing && existing.status === "enabled") {
    return {
      success: true,
      installation: existing,
      alreadyInstalled: true,
    };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const moduleAddress = getAllowanceModuleAddress(chainId);

  const { context, rpcUrl } = buildTxContext({
    organizationId,
    chainId,
    executionId: `safe-install-${generateId()}`,
  });
  context.rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);

  // Surface signer errors before acquiring the nonce lock.
  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  try {
    const enableCalldata = buildExecTransactionCalldata({
      to: safe.safeAddress,
      data: buildEnableModuleCalldata(moduleAddress),
      ownerAddress,
    });
    const addDelegateInner = buildAddDelegateCalldata(ownerAddress);
    const addDelegateCalldata = buildExecTransactionCalldata({
      to: moduleAddress,
      data: addDelegateInner,
      ownerAddress,
    });

    const installedTxHash = await withNonceSession(
      context,
      ownerAddress,
      async (session) => {
        const enableResult = await executeTransaction(
          context,
          ownerAddress,
          () => ({
            to: safe.safeAddress,
            data: enableCalldata,
            value: BigInt(0),
            chainId,
          }),
          session
        );
        if (!enableResult.success) {
          throw new Error(
            enableResult.error ?? "Failed to enable Allowance Module"
          );
        }

        const delegateResult = await executeTransaction(
          context,
          ownerAddress,
          () => ({
            to: safe.safeAddress,
            data: addDelegateCalldata,
            value: BigInt(0),
            chainId,
          }),
          session
        );
        if (!delegateResult.success) {
          throw new Error(
            delegateResult.error ?? "Failed to add delegate to module"
          );
        }
        return enableResult.txHash ?? null;
      }
    );

    const [inserted] = await db
      .insert(safeModuleInstallations)
      .values({
        safeWalletId: safe.id,
        moduleType: MODULE_TYPE_ALLOWANCE,
        moduleAddress: normalizeAddressForStorage(moduleAddress),
        installedTxHash,
        installedAt: new Date(),
        status: "enabled",
      })
      .returning();

    return { success: true, installation: inserted, alreadyInstalled: false };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Safe] Install Allowance Module failed",
      error,
      {
        component: "safe-modules",
        organizationId,
        chain_id: chainId.toString(),
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveTokenMetadata(
  chainId: number,
  tokenAddress: string
): { symbol: string; decimals: number } {
  const info = getTokenInfo(chainId, tokenAddress);
  if (info) {
    return { symbol: info.symbol, decimals: info.decimals };
  }
  return { symbol: "UNKNOWN", decimals: 18 };
}

export async function setTokenAllowance(
  input: SetTokenAllowanceInput
): Promise<SetTokenAllowanceResult> {
  const { organizationId, chainId, tokenAddress, amountWei, periodMinutes } =
    input;

  if (!ethers.isAddress(tokenAddress)) {
    return { success: false, error: `Invalid token address: ${tokenAddress}` };
  }

  const amount = BigInt(amountWei);
  if (amount <= BigInt(0)) {
    return { success: false, error: "amountWei must be greater than zero" };
  }

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return {
      success: false,
      error: "Deploy a Safe on this chain before setting spending limits",
    };
  }

  const installation = await findInstallation(safe.id);
  if (!installation || installation.status !== "enabled") {
    return {
      success: false,
      error: "Enable the Allowance Module before setting spending limits",
    };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const moduleAddress = getAllowanceModuleAddress(chainId);
  const normalizedToken = normalizeAddressForStorage(tokenAddress);
  const { symbol, decimals } = resolveTokenMetadata(chainId, normalizedToken);

  const { context, rpcUrl } = buildTxContext({
    organizationId,
    chainId,
    executionId: `safe-allowance-set-${generateId()}`,
  });
  context.rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  try {
    const innerCalldata = buildSetAllowanceCalldata({
      delegate: ownerAddress,
      token: normalizedToken,
      allowanceAmount: amount,
      resetTimeMinutes: periodMinutes,
    });
    const outerCalldata = buildExecTransactionCalldata({
      to: moduleAddress,
      data: innerCalldata,
      ownerAddress,
    });

    const txHash = await withNonceSession(context, ownerAddress, (session) =>
      executeTransaction(
        context,
        ownerAddress,
        () => ({
          to: safe.safeAddress,
          data: outerCalldata,
          value: BigInt(0),
          chainId,
        }),
        session
      ).then((result) => {
        if (!result.success) {
          throw new Error(result.error ?? "setAllowance tx failed");
        }
        return result.txHash ?? null;
      })
    );

    const [row] = await db
      .insert(safeTokenLimits)
      .values({
        safeWalletId: safe.id,
        moduleType: MODULE_TYPE_ALLOWANCE,
        delegateAddress: ownerAddress,
        tokenAddress: normalizedToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        amountWei: amount.toString(),
        periodMinutes,
        lastTxHash: txHash,
        lastUpdatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          safeTokenLimits.safeWalletId,
          safeTokenLimits.delegateAddress,
          safeTokenLimits.tokenAddress,
        ],
        set: {
          amountWei: amount.toString(),
          periodMinutes,
          lastTxHash: txHash,
          lastUpdatedAt: new Date(),
          tokenSymbol: symbol,
          tokenDecimals: decimals,
        },
      })
      .returning();

    return { success: true, limit: row };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Safe] setTokenAllowance failed",
      error,
      {
        component: "safe-modules",
        organizationId,
        chain_id: chainId.toString(),
        token: normalizedToken,
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function revokeTokenAllowance(
  input: RevokeTokenAllowanceInput
): Promise<RevokeTokenAllowanceResult> {
  const { organizationId, chainId, tokenAddress } = input;

  if (!ethers.isAddress(tokenAddress)) {
    return { success: false, error: `Invalid token address: ${tokenAddress}` };
  }

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return { success: false, error: "Safe not found for this chain" };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const moduleAddress = getAllowanceModuleAddress(chainId);
  const normalizedToken = normalizeAddressForStorage(tokenAddress);

  const { context, rpcUrl } = buildTxContext({
    organizationId,
    chainId,
    executionId: `safe-allowance-revoke-${generateId()}`,
  });
  context.rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  try {
    const innerCalldata = buildDeleteAllowanceCalldata({
      delegate: ownerAddress,
      token: normalizedToken,
    });
    const outerCalldata = buildExecTransactionCalldata({
      to: moduleAddress,
      data: innerCalldata,
      ownerAddress,
    });

    await withNonceSession(context, ownerAddress, (session) =>
      executeTransaction(
        context,
        ownerAddress,
        () => ({
          to: safe.safeAddress,
          data: outerCalldata,
          value: BigInt(0),
          chainId,
        }),
        session
      ).then((result) => {
        if (!result.success) {
          throw new Error(result.error ?? "deleteAllowance tx failed");
        }
      })
    );

    const [deleted] = await db
      .delete(safeTokenLimits)
      .where(
        and(
          eq(safeTokenLimits.safeWalletId, safe.id),
          eq(safeTokenLimits.delegateAddress, ownerAddress),
          eq(safeTokenLimits.tokenAddress, normalizedToken)
        )
      )
      .returning();

    if (!deleted) {
      return {
        success: false,
        error: "Allowance removed on-chain but DB row was already missing",
      };
    }

    return { success: true, deleted };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Safe] revokeTokenAllowance failed",
      error,
      {
        component: "safe-modules",
        organizationId,
        chain_id: chainId.toString(),
        token: normalizedToken,
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listSafeAllowances(
  safeWalletId: string
): Promise<SafeTokenLimit[]> {
  return await db
    .select()
    .from(safeTokenLimits)
    .where(eq(safeTokenLimits.safeWalletId, safeWalletId));
}

export type AllowanceWithChainState = {
  row: SafeTokenLimit;
  onChain: {
    amountWei: string;
    spentWei: string;
    resetTimeMinutes: number;
    lastResetMinutes: number;
    /** Absolute time the spent counter will next roll back to zero. */
    resetAt: string | null;
  };
};

/**
 * Load per-token limits for a Safe AND reconcile against on-chain state.
 * For each DB row, query the Allowance Module via RPC; if on-chain amount is
 * zero (externally revoked via safe.global or the module's own delete
 * function) we drop the stale DB row so the UI reflects truth.
 *
 * Reads are parallelised; DB cleanup runs only when we detect drift.
 */
export async function listSafeAllowancesWithChainState(options: {
  safeWalletId: string;
  safeAddress: string;
  chainId: number;
}): Promise<AllowanceWithChainState[]> {
  const { safeWalletId, safeAddress, chainId } = options;
  const rows = await db
    .select()
    .from(safeTokenLimits)
    .where(eq(safeTokenLimits.safeWalletId, safeWalletId));

  if (rows.length === 0) {
    return [];
  }

  const onChainResults = await Promise.all(
    rows.map((row) =>
      readAllowanceFromChain({
        chainId,
        safeAddress,
        delegate: row.delegateAddress,
        token: row.tokenAddress,
      })
        .then((state) => ({ row, state, error: null as Error | null }))
        .catch((error: unknown) => ({
          row,
          state: null,
          error: error instanceof Error ? error : new Error(String(error)),
        }))
    )
  );

  const staleIds: string[] = [];
  const enriched: AllowanceWithChainState[] = [];

  for (const entry of onChainResults) {
    // Treat unreadable rows (RPC error, decoding mismatch) as non-stale so a
    // transient RPC outage doesn't wipe the user's limits from view.
    if (!entry.state) {
      enriched.push({
        row: entry.row,
        onChain: {
          amountWei: entry.row.amountWei,
          spentWei: "0",
          resetTimeMinutes: entry.row.periodMinutes,
          lastResetMinutes: 0,
          resetAt: null,
        },
      });
      continue;
    }

    const { state } = entry;
    if (state.amount === BigInt(0) && state.lastResetMinutes === 0) {
      // Never set on-chain OR explicitly deleted via deleteAllowance: drop.
      staleIds.push(entry.row.id);
      continue;
    }

    const resetAt =
      state.resetTimeMinutes > 0 && state.lastResetMinutes > 0
        ? new Date(
            (state.lastResetMinutes + state.resetTimeMinutes) * 60 * 1000
          ).toISOString()
        : null;

    enriched.push({
      row: entry.row,
      onChain: {
        amountWei: state.amount.toString(),
        spentWei: state.spent.toString(),
        resetTimeMinutes: state.resetTimeMinutes,
        lastResetMinutes: state.lastResetMinutes,
        resetAt,
      },
    });
  }

  if (staleIds.length > 0) {
    await db
      .delete(safeTokenLimits)
      .where(inArray(safeTokenLimits.id, staleIds));
  }

  return enriched;
}

export async function getSafeInstallation(
  safeWalletId: string
): Promise<SafeModuleInstallation | null> {
  return await findInstallation(safeWalletId);
}

/**
 * Refresh the authoritative allowance state from the on-chain Allowance
 * Module. Used by the UI when it wants to show "X USDC remaining this
 * period" rather than the stale DB cap.
 */
export async function readAllowanceFromChain(options: {
  chainId: number;
  safeAddress: string;
  delegate: string;
  token: string;
}): Promise<ReturnType<typeof decodeTokenAllowance>> {
  const { chainId, safeAddress, delegate, token } = options;
  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  const provider = rpcManager.getProvider();
  const moduleAddress = getAllowanceModuleAddress(chainId);
  const contract = new ethers.Contract(
    moduleAddress,
    ALLOWANCE_MODULE_ABI,
    provider
  );
  const raw = (await contract.getTokenAllowance(
    safeAddress,
    delegate,
    token
  )) as [bigint, bigint, bigint, bigint, bigint];
  return decodeTokenAllowance(raw);
}
