import "server-only";
import { TurnkeySigner } from "@turnkey/ethers";
import { and, eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { toChecksumAddress } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { type OrganizationWallet, organizationWallets } from "@/lib/db/schema";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getTurnkeySignerConfig } from "@/lib/turnkey/turnkey-client";

/**
 * Get organization's active wallet from database.
 * During Para → Turnkey migration an org may temporarily hold both wallets;
 * only the one flagged `isActive = true` is used by workflows and integrations.
 */
export async function getOrganizationWallet(
  organizationId: string
): Promise<OrganizationWallet> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  if (wallet.length === 0) {
    throw new Error("No wallet found for organization");
  }

  return wallet[0];
}

/**
 * @deprecated Use getOrganizationWallet instead
 */
export async function getUserWallet(userId: string) {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.userId, userId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  if (wallet.length === 0) {
    throw new Error("No wallet found for user");
  }

  return wallet[0];
}

/**
 * Initialize an ethers-compatible signer for the organization's active wallet.
 * Turnkey is the only supported signer; legacy Para wallets throw so the
 * org is forced to provision a Turnkey wallet via the create flow.
 */
export async function initializeWalletSigner(
  organizationId: string,
  rpcUrl: string,
  chainId: number
): Promise<ethers.Signer> {
  const wallet = await getOrganizationWallet(organizationId);
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  const provider = rpcManager.getProvider();

  if (wallet.provider !== "turnkey") {
    throw new Error(
      "Para signing is no longer supported. Recreate the wallet via the wallet UI to use Turnkey."
    );
  }
  return initializeTurnkeySigner(wallet, provider);
}

function initializeTurnkeySigner(
  wallet: { turnkeySubOrgId: string | null; walletAddress: string },
  provider: ethers.Provider
): ethers.Signer {
  if (!wallet.turnkeySubOrgId) {
    throw new Error("Turnkey wallet missing sub-organization ID");
  }

  const config = getTurnkeySignerConfig(
    wallet.turnkeySubOrgId,
    toChecksumAddress(wallet.walletAddress)
  );

  const signer = new TurnkeySigner({
    client: config.client,
    organizationId: config.organizationId,
    signWith: config.signWith,
  });

  return signer.connect(provider);
}

/**
 * Get organization's wallet address
 */
export async function getOrganizationWalletAddress(
  organizationId: string
): Promise<string> {
  const wallet = await getOrganizationWallet(organizationId);
  return wallet.walletAddress;
}

/**
 * Check if organization has a wallet
 */
export async function organizationHasWallet(
  organizationId: string
): Promise<boolean> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  return wallet.length > 0;
}

/**
 * @deprecated Use getOrganizationWalletAddress instead
 */
export async function getUserWalletAddress(userId: string): Promise<string> {
  const wallet = await getUserWallet(userId);
  return wallet.walletAddress;
}

/**
 * @deprecated Use organizationHasWallet instead
 */
export async function userHasWallet(userId: string): Promise<boolean> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.userId, userId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  return wallet.length > 0;
}
