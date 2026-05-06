import "server-only";

import { and, eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { chains, type SafeWallet, safeWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getOrganizationWallet,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import {
  buildCreateProxyCalldata,
  buildSetupCalldata,
  orgSaltNonce,
  parseProxyCreationEvent,
} from "@/lib/safe/address";
import {
  getSafeContracts,
  getSafeSingletonForDeploy,
  isSafeSupportedChain,
  SAFE_VERSION,
} from "@/lib/safe/contracts";
import { generateId } from "@/lib/utils/id";
import {
  executeTransaction,
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

export type DeployOrgSafeInput = {
  organizationId: string;
  chainId: number;
  /**
   * Optional synthetic execution ID for telemetry/nonce tracking. When omitted
   * we mint one; there is no workflow behind a Safe deploy.
   */
  executionId?: string;
};

export type DeployOrgSafeResult =
  | {
      success: true;
      safe: SafeWallet;
      alreadyDeployed: boolean;
    }
  | { success: false; error: string };

async function findExistingSafe(
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

async function chainIsEnabled(chainId: number): Promise<boolean> {
  const [row] = await db
    .select({ isEnabled: chains.isEnabled, chainType: chains.chainType })
    .from(chains)
    .where(eq(chains.chainId, chainId))
    .limit(1);

  if (!row) {
    return false;
  }
  return row.chainType === "evm" && row.isEnabled === true;
}

function validateReceiptStatus(receipt: ethers.TransactionReceipt): void {
  if (receipt.status !== 1) {
    throw new Error(
      `Safe deployment transaction reverted (status ${receipt.status})`
    );
  }
}

/**
 * Deploy a Safe smart account for an organization on the given chain.
 *
 * Idempotent: if a safe_wallets row already exists for (org, chain) the
 * existing row is returned and no tx is sent. The Safe is initialised with
 * the org's active EOA (Turnkey/Para) as sole owner, threshold = 1.
 */
export async function deployOrgSafe(
  input: DeployOrgSafeInput
): Promise<DeployOrgSafeResult> {
  const { organizationId, chainId } = input;

  if (!isSafeSupportedChain(chainId)) {
    return {
      success: false,
      error: `Safe deployment is not supported on chain ${chainId}`,
    };
  }

  const enabled = await chainIsEnabled(chainId);
  if (!enabled) {
    return {
      success: false,
      error: `Chain ${chainId} is not enabled for deployment`,
    };
  }

  const existing = await findExistingSafe(organizationId, chainId);
  if (existing && existing.status === "deployed") {
    return { success: true, safe: existing, alreadyDeployed: true };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);

  const contracts = getSafeContracts(chainId);
  const singleton = getSafeSingletonForDeploy(chainId);
  const saltNonce = orgSaltNonce(organizationId, chainId);
  const initializer = buildSetupCalldata({
    owners: [ownerAddress],
    threshold: 1,
    fallbackHandler: contracts.compatibilityFallbackHandler,
  });
  const calldata = buildCreateProxyCalldata({
    singleton,
    initializer,
    saltNonce,
  });

  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  const executionId = input.executionId ?? `safe-deploy-${generateId()}`;

  const context: TransactionContext = {
    organizationId,
    executionId,
    chainId,
    rpcUrl,
    rpcManager,
  };

  // Signer isn't used directly here (executeTransaction builds its own inside
  // the nonce session), but we call initializeWalletSigner early to surface a
  // clear error if the EOA is unreachable before acquiring the nonce lock.
  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  try {
    const result = await withNonceSession(context, ownerAddress, (session) =>
      executeTransaction(
        context,
        ownerAddress,
        () => ({
          to: contracts.proxyFactory,
          data: calldata,
          value: BigInt(0),
          chainId,
        }),
        session
      )
    );

    if (!(result.success && result.receipt)) {
      throw new Error(result.error ?? "Safe deployment failed");
    }

    validateReceiptStatus(result.receipt);
    const safeAddress = parseProxyCreationEvent(
      result.receipt,
      contracts.proxyFactory
    );

    const normalizedSafeAddress = normalizeAddressForStorage(safeAddress);

    const [inserted] = await db
      .insert(safeWallets)
      .values({
        organizationId,
        chainId,
        safeAddress: normalizedSafeAddress,
        ownerWalletId: ownerWallet.id,
        owners: [ownerAddress],
        threshold: 1,
        saltNonce: saltNonce.toString(),
        safeVersion: SAFE_VERSION,
        singletonAddress: normalizeAddressForStorage(singleton),
        factoryAddress: normalizeAddressForStorage(contracts.proxyFactory),
        deploymentTxHash: result.txHash,
        deploymentBlock: result.receipt.blockNumber,
        status: "deployed",
        deployedAt: new Date(),
      })
      .returning();

    return { success: true, safe: inserted, alreadyDeployed: false };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Deployment failed for org=${organizationId}`,
      error,
      {
        component: "safe-deployment",
        chain_id: chainId.toString(),
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listOrgSafes(
  organizationId: string
): Promise<SafeWallet[]> {
  return await db
    .select()
    .from(safeWallets)
    .where(eq(safeWallets.organizationId, organizationId));
}
