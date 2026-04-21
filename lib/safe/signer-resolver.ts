import "server-only";

import { and, eq } from "drizzle-orm";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { safeWallets } from "@/lib/db/schema";
import {
  getOrganizationWallet,
  getOrganizationWalletAddress,
} from "@/lib/para/wallet-helpers";

/**
 * Resolution result: which mode should a workflow write on this (org, chain)
 * execute in, and what addresses matter.
 *
 * In both modes the Turnkey EOA signs the outer Ethereum tx (nonce on the
 * EOA, gas paid by the EOA). The difference is `msg.sender` at the target
 * contract, and therefore which address needs to hold the funds and receive
 * protocol positions.
 */
export type SignerMode =
  | {
      kind: "eoa";
      ownerAddress: string;
    }
  | {
      kind: "safe";
      ownerAddress: string;
      safeAddress: string;
      safeWalletId: string;
    };

/**
 * Decide whether a workflow write on (orgId, chainId) should execute from
 * the Turnkey EOA directly (default) or route through the Safe via
 * owner-signed `safe.execTransaction`.
 *
 * Returns `safe` mode only when:
 *   - A safe_wallets row exists for this (org, chain)
 *   - status = "deployed" (never route through a half-deployed Safe)
 *   - is_signing_active = true (admin has explicitly opted in)
 *
 * Any other state -> `eoa` mode (matches pre-Phase-3 behavior).
 */
export async function resolveSignerMode(
  organizationId: string,
  chainId: number
): Promise<SignerMode> {
  const ownerAddress = normalizeAddressForStorage(
    await getOrganizationWalletAddress(organizationId)
  );

  const rows = await db
    .select({
      id: safeWallets.id,
      safeAddress: safeWallets.safeAddress,
      status: safeWallets.status,
      isSigningActive: safeWallets.isSigningActive,
    })
    .from(safeWallets)
    .where(
      and(
        eq(safeWallets.organizationId, organizationId),
        eq(safeWallets.chainId, chainId)
      )
    )
    .limit(1);

  const safe = rows[0];
  if (!safe) {
    return { kind: "eoa", ownerAddress };
  }
  if (safe.status !== "deployed" || !safe.isSigningActive) {
    return { kind: "eoa", ownerAddress };
  }

  return {
    kind: "safe",
    ownerAddress,
    safeAddress: safe.safeAddress,
    safeWalletId: safe.id,
  };
}

/**
 * Convenience wrapper: returns the owning Turnkey wallet row AND the signer
 * mode in a single resolution. Callers that already need the wallet row
 * (e.g. to obtain the ethers Signer) can avoid a second DB hit.
 */
export async function resolveWalletAndSignerMode(
  organizationId: string,
  chainId: number
): Promise<{
  ownerWallet: Awaited<ReturnType<typeof getOrganizationWallet>>;
  signerMode: SignerMode;
}> {
  const [ownerWallet, signerMode] = await Promise.all([
    getOrganizationWallet(organizationId),
    resolveSignerMode(organizationId, chainId),
  ]);
  return { ownerWallet, signerMode };
}
