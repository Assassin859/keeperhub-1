import "server-only";

import { and, eq } from "drizzle-orm";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import type { SafeWallet } from "@/lib/db/schema";
import { safeRoles, safeWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  recordSignerMode,
  recordSignerProbeFailure,
} from "@/lib/metrics/instrumentation/safe";
import {
  getOrganizationWallet,
  getOrganizationWalletAddress,
} from "@/lib/para/wallet-helpers";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
// reconcileSafeRoleFromChain is dynamically imported below to keep the
// roles-orchestrator (and its defi-kit transitive dep, which proxies the
// entire SDK at module load) out of the import graph for routes that only
// need the signer-mode resolution. Static imports here pull defi-kit into
// every API route that does a workflow write, which trips a recursive
// mapSdk overflow during Next.js page-data collection.
import { orgAutomationRoleKey } from "@/lib/safe/zodiac-contracts";
import {
  findRolesModifierForSafe,
  readEnabledSafeModules,
} from "@/lib/safe/zodiac-roles";

/**
 * Resolution result: which mode should a workflow write on this (org, chain)
 * execute in, and what addresses matter.
 *
 * In every mode the Turnkey EOA signs the outer Ethereum tx (nonce on the
 * EOA, gas paid by the EOA). The difference is `msg.sender` at the target
 * contract, and therefore which address needs to hold the funds and receive
 * protocol positions.
 *
 * Modes:
 *   - "eoa"       : Turnkey signs and calls the target directly.
 *   - "safe"      : Safe mode ON but no Zodiac Role is active; writes go via
 *                   owner-signed `safe.execTransaction` (no policy gating).
 *   - "safe-role" : Safe mode ON and a Zodiac Role is applied; writes go via
 *                   `rolesModifier.execTransactionWithRole` so every call is
 *                   validated against the role's scope + allowances.
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
    }
  | {
      kind: "safe-role";
      ownerAddress: string;
      safeAddress: string;
      safeWalletId: string;
      rolesModifierAddress: string;
      roleKey: string;
      delegateAddress: string;
    };

/**
 * One-shot chain probe to detect a Roles modifier enabled on a Safe even
 * when our DB has no `safe_roles` row. Used as a recovery path when the
 * install's post-tx DB write dropped a row -- the workflow runner should
 * still route through the modifier rather than silently downgrading to
 * unscoped owner-signed mode.
 *
 * Reads are routed through `RpcProviderManager.executeWithFailover` so a
 * transient primary-RPC outage falls back to the configured secondary
 * endpoint rather than downgrading the workflow to `safe` mode. Returns
 * the modifier's address on success, null otherwise. Errors are only
 * swallowed once *both* primary and fallback have failed; the next
 * reconcile (or the user-triggered Sync button) repairs the DB later.
 */
async function probeRolesModifierFromChain(
  safe: Pick<SafeWallet, "id" | "chainId" | "safeAddress">
): Promise<string | null> {
  try {
    // Deliberately uses the static chain RPC config rather than
    // `resolveRpcConfig(chainId, userId, ...)`. The probe issues stateless
    // `eth_call`s (readEnabledSafeModules, findRolesModifierForSafe) that
    // should not be routed through any user write-side private mempool
    // (Flashbots Protect, custom bundler endpoints, etc.). Those endpoints
    // are not designed to serve reads, and routing them would leak the
    // workflow's resolver-time RPC traffic into the user's private channel.
    // Reads always go to the public/configured chain RPC; user RPC prefs
    // apply only to the broadcast side. See KEEP-566.
    const primaryRpcUrl = getRpcUrlByChainId(safe.chainId, "primary");
    const fallbackRpcUrl = getRpcUrlByChainId(safe.chainId, "fallback");
    const rpcManager = await getRpcProviderFromUrls(
      primaryRpcUrl,
      fallbackRpcUrl === primaryRpcUrl ? undefined : fallbackRpcUrl,
      safe.chainId
    );
    const modules = await rpcManager.executeWithFailover((provider) =>
      readEnabledSafeModules(provider, safe.safeAddress)
    );
    if (modules.length === 0) {
      return null;
    }
    return await rpcManager.executeWithFailover((provider) =>
      findRolesModifierForSafe(provider, safe.safeAddress, modules)
    );
  } catch (error) {
    // KEEP-567: probe hit both-RPC failure. We currently swallow and let
    // the caller downgrade to unscoped `safe` mode (policy enforcement
    // gone for the window). Emit a counter so the silent-downgrade
    // frequency is observable before deciding whether to hard-fail the
    // resolver instead. Logged via logSystemError (Sentry) AND the
    // signer_probe.failure counter (dashboards).
    recordSignerProbeFailure({ chainId: safe.chainId });
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] signer-resolver chain probe failed for safe=${safe.id}`,
      error,
      {
        component: "safe-signer-resolver",
        chain_id: safe.chainId.toString(),
      }
    );
    return null;
  }
}

/**
 * Kick off a background reconcile that backfills the DB cache. Errors are
 * logged and swallowed; we don't surface them to the caller because the
 * routing decision has already been made and the modifier on chain is the
 * source of truth for enforcement either way.
 *
 * Implemented as a normal function rather than `void promise` so the
 * useless-void lint rule stays happy and the intent reads clearly at the
 * call site.
 */
function backfillRoleInBackground(safe: SafeWallet): void {
  import("@/lib/safe/roles-orchestrator")
    .then(({ reconcileSafeRoleFromChain }) => reconcileSafeRoleFromChain(safe))
    .then(
      () => {
        // success path: nothing to do, the DB row is now in place.
      },
      (error: unknown) => {
        logSystemError(
          ErrorCategory.TRANSACTION,
          `[Safe] background reconcile after probe failed for safe=${safe.id}`,
          error,
          {
            component: "safe-signer-resolver",
            chain_id: safe.chainId.toString(),
          }
        );
      }
    );
}

/**
 * Decide whether a workflow write on (orgId, chainId) should execute from
 * the Turnkey EOA directly (default) or route through the Safe.
 *
 * Routing is DB-first for speed (a single SQL query in the steady state),
 * but recovers from cache drift on the way down:
 *
 *   - DB has an active `safe_roles` row -> route through `execTransactionWithRole`.
 *     The modifier on chain is the source of truth for enforcement -- if our
 *     row is wrong (e.g. modifier was disabled out-of-band) the tx reverts
 *     loudly rather than silently bypassing the role.
 *
 *   - DB has no role row but Safe is deployed + signing is active -> probe
 *     chain once. If a Roles modifier is enabled, route through `safe-role`
 *     using the chain-probed modifier address and fire a background reconcile
 *     so the DB catches up. Closes the silent-write hole that previously
 *     downgraded these workflows to unscoped owner-signed `execTransaction`.
 *
 *   - Otherwise -> plain `safe` mode (signing on, no role) or `eoa` mode
 *     (signing off, or no Safe at all).
 */
export async function resolveSignerMode(
  organizationId: string,
  chainId: number
): Promise<SignerMode> {
  const mode = await resolveSignerModeImpl(organizationId, chainId);
  // KEEP-568: emit a single resolver-level counter so dashboards can track
  // the eoa / safe / safe-role distribution. The per-tx `safe.tx.*` counter
  // only sees the two Safe branches; this one also covers EOA.
  recordSignerMode({ kind: mode.kind, chainId });
  return mode;
}

async function resolveSignerModeImpl(
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

  // Check whether an active Zodiac Role is installed for this Safe. If so,
  // every workflow write routes through `execTransactionWithRole` so the
  // modifier can enforce scope + allowances. If not, fall back to plain
  // owner-signed `execTransaction` (policy gating unavailable).
  const roleRows = await db
    .select({
      rolesModifierAddress: safeRoles.rolesModifierAddress,
      roleKey: safeRoles.roleKey,
      delegateAddress: safeRoles.delegateAddress,
      status: safeRoles.status,
    })
    .from(safeRoles)
    .where(
      and(
        eq(safeRoles.safeWalletId, safe.id),
        eq(safeRoles.roleType, "automation")
      )
    )
    .limit(1);

  const role = roleRows[0];
  if (role && role.status === "active") {
    return {
      kind: "safe-role",
      ownerAddress,
      safeAddress: safe.safeAddress,
      safeWalletId: safe.id,
      rolesModifierAddress: role.rolesModifierAddress,
      roleKey: role.roleKey,
      delegateAddress: role.delegateAddress,
    };
  }

  // No DB role row, but signing is active. The wizard could have installed
  // a modifier on chain whose post-tx DB write dropped (silent-write hole),
  // or someone enabled the modifier on safe.global manually. Probe chain
  // once and route through `safe-role` if a modifier is found.
  const probedModifier = await probeRolesModifierFromChain({
    id: safe.id,
    chainId,
    safeAddress: safe.safeAddress,
  });
  if (probedModifier) {
    // Backfill the DB so future executions skip the probe. We don't await:
    // the modifier on chain enforces the role regardless of our cache, so
    // the routing decision is safe to make before the cache is rehydrated.
    const safeForReconcile: SafeWallet = {
      id: safe.id,
      organizationId,
      chainId,
      safeAddress: safe.safeAddress,
      status: safe.status,
      isSigningActive: safe.isSigningActive,
    } as SafeWallet;
    backfillRoleInBackground(safeForReconcile);

    return {
      kind: "safe-role",
      ownerAddress,
      safeAddress: safe.safeAddress,
      safeWalletId: safe.id,
      rolesModifierAddress: normalizeAddressForStorage(probedModifier),
      roleKey: orgAutomationRoleKey(organizationId, chainId),
      delegateAddress: ownerAddress,
    };
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
