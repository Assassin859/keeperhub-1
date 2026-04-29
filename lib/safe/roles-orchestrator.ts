import "server-only";

import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
// biome-ignore lint/style/useImportType: SDK values, not just types
// biome-ignore lint/style/useImportType: rolesAbi is used as a value for Interface
import {
  callsPlannedForApplyRole,
  encodeCalls,
  type Permission,
  type Role,
  rolesAbi,
} from "zodiac-roles-sdk";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { getTokenInfo } from "@/lib/contracts/tokens";
import { db } from "@/lib/db";
import {
  type SafeRole,
  type SafeRoleAllowance,
  type SafeRoleProtocol,
  type SafeWallet,
  safeRoleAllowances,
  safeRoleProtocols,
  safeRoles,
  safeWallets,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getOrganizationWallet,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import { buildExecTransactionCalldata } from "@/lib/safe/allowance-module";
import {
  TEMPLATE_SPECS,
  type TemplateInput,
  type TemplateSlug,
} from "@/lib/safe/condition-templates";
import { getSafeContracts } from "@/lib/safe/contracts";
import { PROTOCOL_CATALOG } from "@/lib/safe/protocol-registry";
import { buildDesiredRole } from "@/lib/safe/simulate";
import {
  getModuleProxyFactoryAddress,
  getRolesSingletonAddress,
  orgAutomationRoleKey,
  tokenAllowanceKey,
} from "@/lib/safe/zodiac-contracts";
import {
  buildDeployRolesCalldata,
  buildMultiSendCalldata,
  buildRolesSetUpCalldata,
  buildSetAllowanceCalldata,
  type MultiSendCall,
  parseModuleProxyCreationEvent,
} from "@/lib/safe/zodiac-roles";
import { generateId } from "@/lib/utils/id";
import {
  executeTransaction,
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

const ROLE_TYPE_AUTOMATION = "automation" as const;

/**
 * The per-role ABI encoder, reused across this file. We compute calldata for
 * module methods (enableModule on Safe, assignRoles / setDefaultRole /
 * setAllowance on the modifier) and pack them into MultiSend blobs.
 */
const safeEnableModuleInterface = new ethers.Interface([
  "function enableModule(address module)",
]);
const rolesInterface = new ethers.Interface(rolesAbi);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-token spending cap the admin configured under a protocol. Amount is
 * expressed in human units ("100", "0.5") plus decimals so the orchestrator
 * can convert to wei server-side. Period is daily / weekly / monthly in
 * seconds.
 */
export type TokenLimitInput = {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountHuman: string;
  periodSeconds: number;
};

/**
 * One protocol row from the policy wizard: the admin selected this
 * protocol and scoped it to these tokens with these per-period caps.
 */
export type ProtocolInput = {
  slug: string;
  tokens: TokenLimitInput[];
};

/**
 * "Direct" rules sit outside any protocol preset. They scope the role to
 * call ERC20 transfer / approve / native ETH transfer at a specific
 * counterparty (recipient or spender). Today they install as a target-level
 * allowlist plus a setAllowance bucket for the ERC20 ones. Per-parameter
 * constraints on transfer/approve calldata are a follow-up; the bucket is
 * still useful so the UI can show "remaining this period" from chain.
 */
export type DirectRuleInput = {
  kind: "erc20-transfer" | "erc20-approve" | "native-transfer";
  /** ERC20 token contract address; null for native-transfer */
  tokenAddress: string | null;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Recipient (transfer/native) or spender (approve) */
  counterparty: string;
  amountHuman: string;
  periodSeconds: number;
};

/** Synthetic protocol slug for direct rules in safe_role_allowances. */
export const DIRECT_RULE_PROTOCOL_SLUG = "direct" as const;

export type InstallRoleInput = {
  organizationId: string;
  chainId: number;
  protocols: ProtocolInput[];
  directRules?: DirectRuleInput[];
};

export type InstallRoleResult =
  | {
      success: true;
      role: SafeRole;
      protocols: SafeRoleProtocol[];
      allowances: SafeRoleAllowance[];
      applied: string[];
      skipped: string[];
      alreadyInstalled: boolean;
    }
  | { success: false; error: string };

export type SetAllowanceInput = {
  organizationId: string;
  chainId: number;
  protocolSlug: string;
  tokenAddress: string;
  maxRefillWei: string;
  refillWei: string;
  periodSeconds: number;
  /** Optional overrides used when the token isn't in the server registry */
  tokenSymbol?: string;
  tokenDecimals?: number;
};

export type SetAllowanceResult =
  | { success: true; allowance: SafeRoleAllowance }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

async function findRoleForSafe(safeWalletId: string): Promise<SafeRole | null> {
  const rows = await db
    .select()
    .from(safeRoles)
    .where(
      and(
        eq(safeRoles.safeWalletId, safeWalletId),
        eq(safeRoles.roleType, ROLE_TYPE_AUTOMATION)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

function resolveTokenMetadata(
  chainId: number,
  tokenAddress: string,
  fallbackSymbol?: string,
  fallbackDecimals?: number
): { symbol: string; decimals: number } {
  const info = getTokenInfo(chainId, tokenAddress);
  if (info) {
    return { symbol: info.symbol, decimals: info.decimals };
  }
  return {
    symbol: fallbackSymbol ?? "UNKNOWN",
    decimals: fallbackDecimals ?? 18,
  };
}

/**
 * Compile the Permission[] for the admin's selected protocols, merging every
 * protocol's preset into one flat list. The SDK's processPermissions handles
 * merging duplicates across protocols when the same target+selector appears.
 */
async function buildPermissionsForProtocols(options: {
  chainId: number;
  safeAddress: `0x${string}`;
  protocols: string[];
  allowedTokenSymbols: string[];
}): Promise<{
  permissions: Permission[];
  applied: string[];
  skipped: string[];
}> {
  const input: TemplateInput = {
    chainId: options.chainId,
    allowedTokenSymbols: options.allowedTokenSymbols,
    safeAddress: options.safeAddress,
  };
  const permissions: Permission[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const slug of options.protocols) {
    const catalog = PROTOCOL_CATALOG[slug as keyof typeof PROTOCOL_CATALOG];
    if (!catalog?.chainIds.includes(options.chainId)) {
      // Protocol not recognised on this chain yet. Skip gracefully so the
      // rest of the install can proceed; the API returns the skipped list.
      skipped.push(slug);
      continue;
    }
    const template = TEMPLATE_SPECS[catalog.templateSlug as TemplateSlug];
    if (!template) {
      skipped.push(slug);
      continue;
    }
    try {
      const permissionSet = await template.build(input);
      for (const p of permissionSet) {
        permissions.push(p);
      }
      applied.push(slug);
    } catch {
      // A preset can throw if defi-kit rejects the token symbols (e.g.
      // asking Aave for a token it has no reserve for). Swallow per
      // protocol so one bad selection doesn't block the rest.
      skipped.push(slug);
    }
  }
  return { permissions, applied, skipped };
}

/**
 * Compute the deterministic address the ModuleProxyFactory will deploy the
 * Roles modifier to. Same as the Safe ProxyFactory trick: minimal proxy
 * bytecode + singleton = deterministic CREATE2 address.
 *
 * We could also call `proxyCreationCode()` on the factory at runtime, but
 * for typed callers we prefer parsing the event on the deploy tx receipt
 * and using that as the authoritative address. This helper exists for
 * pre-flight display only.
 */
function defaultSaltNonce(options: {
  organizationId: string;
  chainId: number;
}): bigint {
  const encoded = ethers.solidityPacked(
    ["string", "string", "uint256"],
    ["kh-zodiac-roles", options.organizationId, BigInt(options.chainId)]
  );
  const hash = ethers.keccak256(encoded);
  return BigInt(`0x${hash.slice(-32)}`);
}

// ---------------------------------------------------------------------------
// Install: deploy Roles modifier + enableModule + assignRoles + initial scope
// ---------------------------------------------------------------------------

/**
 * First-time installation flow. Runs two on-chain transactions:
 *
 * 1. `moduleProxyFactory.deployModule(rolesSingleton, setUp(init), salt)` —
 *    owner-signed from the Turnkey EOA. Captures the proxy address from the
 *    `ModuleProxyCreation` event.
 *
 * 2. A single Safe.execTransaction wrapping a MultiSend that:
 *    - Safe.enableModule(proxy)
 *    - proxy.assignRoles(delegate, [roleKey], [true])
 *    - proxy.setDefaultRole(delegate, roleKey)
 *    - Role target/function scoping (from processed permissions)
 *    - proxy.setAllowance(...) per requested token allowance
 *
 * Idempotent: if a `safe_roles` row already exists and the modifier is
 * enabled on chain, the call returns the existing row without a second tx.
 */
const HUMAN_AMOUNT_REGEX = /^\d+(\.\d+)?$/;
const LEADING_ZEROS_REGEX = /^0+/;

/**
 * Convert "100.5" + decimals=6 into BigInt(100500000). Rejects malformed
 * numbers with a clear error so the orchestrator can short-circuit before
 * sending any tx.
 */
function humanToWei(amountHuman: string, decimals: number): bigint {
  const trimmed = amountHuman.trim();
  if (!HUMAN_AMOUNT_REGEX.test(trimmed)) {
    throw new Error(`Invalid amount: ${amountHuman}`);
  }
  const [intPart, fracRaw] = trimmed.split(".");
  const fracPart = (fracRaw ?? "").padEnd(decimals, "0").slice(0, decimals);
  const combined =
    `${intPart}${fracPart}`.replace(LEADING_ZEROS_REGEX, "") || "0";
  return BigInt(combined);
}

/**
 * Per-(protocol, token) allowance entry emitted by `flattenInstallInput`.
 * Each row maps directly to one on-chain `setAllowance` call and one
 * `safe_role_allowances` DB row.
 */
export type FlattenedAllowance = {
  protocolSlug: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  maxRefillWei: string;
  refillWei: string;
  periodSeconds: number;
};

/**
 * Flatten per-protocol token configuration. No cross-protocol aggregation:
 * each `(protocolSlug, tokenAddress)` pair becomes its own allowance bucket
 * so two protocols can hold independent caps for the same token.
 *
 * Returns the slug list (for `buildPermissionsForProtocols`), the union of
 * token symbols (what the per-parameter presets scope), and the flat list
 * of allowance rows.
 */
export function flattenInstallInput(
  protocolInputs: ProtocolInput[],
  directRules: DirectRuleInput[] = []
): {
  protocolSlugs: string[];
  allowedTokenSymbols: string[];
  allowances: FlattenedAllowance[];
} {
  const slugs = protocolInputs.map((p) => p.slug);
  const symbols = new Set<string>();
  const allowances: FlattenedAllowance[] = [];

  for (const p of protocolInputs) {
    for (const t of p.tokens) {
      symbols.add(t.tokenSymbol);
      const addr = normalizeAddressForStorage(t.tokenAddress);
      const amount = humanToWei(t.amountHuman, t.tokenDecimals);
      allowances.push({
        protocolSlug: p.slug,
        tokenAddress: addr,
        tokenSymbol: t.tokenSymbol,
        tokenDecimals: t.tokenDecimals,
        maxRefillWei: amount.toString(),
        refillWei: amount.toString(),
        periodSeconds: t.periodSeconds,
      });
    }
  }

  // Direct rules: only ERC20 ones contribute to safe_role_allowances. Native
  // transfers are scoped at the recipient target only (no on-chain value cap
  // until a transaction guard ships).
  for (const rule of directRules) {
    if (rule.kind === "native-transfer" || !rule.tokenAddress) {
      continue;
    }
    symbols.add(rule.tokenSymbol);
    const addr = normalizeAddressForStorage(rule.tokenAddress);
    const amount = humanToWei(rule.amountHuman, rule.tokenDecimals);
    allowances.push({
      protocolSlug: DIRECT_RULE_PROTOCOL_SLUG,
      tokenAddress: addr,
      tokenSymbol: rule.tokenSymbol,
      tokenDecimals: rule.tokenDecimals,
      maxRefillWei: amount.toString(),
      refillWei: amount.toString(),
      periodSeconds: rule.periodSeconds,
    });
  }

  return {
    protocolSlugs: slugs,
    allowedTokenSymbols: Array.from(symbols),
    allowances,
  };
}

export async function installRolesWithInitialConfig(
  input: InstallRoleInput
): Promise<InstallRoleResult> {
  const {
    organizationId,
    chainId,
    protocols: protocolInputs,
    directRules = [],
  } = input;
  const {
    protocolSlugs: protocols,
    allowedTokenSymbols,
    allowances: tokenAllowances,
  } = flattenInstallInput(protocolInputs, directRules);

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return {
      success: false,
      error: "Deploy a Safe on this chain before installing Zodiac Roles",
    };
  }
  if (safe.status !== "deployed") {
    return {
      success: false,
      error: `Safe is not yet deployed (status: ${safe.status})`,
    };
  }

  const existingRole = await findRoleForSafe(safe.id);
  if (existingRole && existingRole.status === "active") {
    const protocolRows = await db
      .select()
      .from(safeRoleProtocols)
      .where(eq(safeRoleProtocols.roleId, existingRole.id));
    const allowanceRows = await db
      .select()
      .from(safeRoleAllowances)
      .where(eq(safeRoleAllowances.roleId, existingRole.id));
    return {
      success: true,
      role: existingRole,
      protocols: protocolRows,
      allowances: allowanceRows,
      applied: protocolRows.map((r) => r.protocolSlug),
      skipped: [],
      alreadyInstalled: true,
    };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const safeAddress = safe.safeAddress as `0x${string}`;
  const rolesSingleton = getRolesSingletonAddress(chainId);
  const moduleProxyFactory = getModuleProxyFactoryAddress(chainId);
  const multiSendAddress = getSafeContracts(chainId).multiSendCallOnly;
  const roleKey = orgAutomationRoleKey(
    organizationId,
    chainId
  ) as `0x${string}`;
  const saltNonce = defaultSaltNonce({ organizationId, chainId });

  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  const context: TransactionContext = {
    organizationId,
    executionId: `safe-roles-install-${generateId()}`,
    chainId,
    rpcUrl,
    triggerType: "manual",
    rpcManager,
  };

  try {
    // Step 1 — deploy the Roles modifier proxy
    const setUpCalldata = buildRolesSetUpCalldata({
      owner: safeAddress,
      avatar: safeAddress,
      target: safeAddress,
    });
    const deployCalldata = buildDeployRolesCalldata({
      rolesSingleton,
      initializer: setUpCalldata,
      saltNonce,
    });

    const deployResult = await withNonceSession(
      context,
      ownerAddress,
      (session) =>
        executeTransaction(
          context,
          ownerAddress,
          () => ({
            to: moduleProxyFactory,
            data: deployCalldata,
            value: BigInt(0),
            chainId,
          }),
          session
        )
    );

    if (!(deployResult.success && deployResult.receipt)) {
      throw new Error(deployResult.error ?? "Roles modifier deploy reverted");
    }

    const rolesModifierAddress = parseModuleProxyCreationEvent(
      deployResult.receipt,
      moduleProxyFactory
    ) as `0x${string}`;

    // Step 2 build the config MultiSend. Some protocols may not have a
    // condition template yet; we skip those here and let the UI know which
    // were applied vs skipped so the admin can retry later.
    const {
      permissions,
      applied: appliedProtocols,
      skipped: skippedProtocols,
    } = await buildPermissionsForProtocols({
      chainId,
      safeAddress,
      protocols,
      allowedTokenSymbols,
    });

    // Direct rules: scope each rule's counterparty (or the ERC20 token
    // contract for transfer/approve) at target level. The on-chain bucket
    // for ERC20 rules is set further below in the per-allowance loop.
    const directRulePermissions: Permission[] = [];
    for (const rule of directRules) {
      const target =
        rule.kind === "native-transfer"
          ? rule.counterparty
          : (rule.tokenAddress ?? "");
      if (!ethers.isAddress(target)) {
        continue;
      }
      directRulePermissions.push({
        targetAddress: ethers.getAddress(target) as `0x${string}`,
        send: rule.kind === "native-transfer",
        delegatecall: false,
      } as unknown as Permission);
    }

    const desiredRole: Role = buildDesiredRole({
      roleKey,
      delegate: ownerAddress as `0x${string}`,
      permissions: [...permissions, ...directRulePermissions],
    });
    const emptyRole: Role = {
      key: roleKey,
      members: [],
      targets: [],
      annotations: [],
      lastUpdate: 0,
    };
    const permissionCalls = callsPlannedForApplyRole(emptyRole, desiredRole);
    const encodedPermissionCalls = encodeCalls(
      permissionCalls,
      rolesModifierAddress
    );

    const multiSendCalls: MultiSendCall[] = [];

    // a. enableModule on Safe
    multiSendCalls.push({
      to: safeAddress,
      data: safeEnableModuleInterface.encodeFunctionData("enableModule", [
        rolesModifierAddress,
      ]),
      value: BigInt(0),
      operation: 0,
    });

    // b. assignRoles + setDefaultRole on modifier
    multiSendCalls.push({
      to: rolesModifierAddress,
      data: rolesInterface.encodeFunctionData("assignRoles", [
        ownerAddress,
        [roleKey],
        [true],
      ]),
      value: BigInt(0),
      operation: 0,
    });
    multiSendCalls.push({
      to: rolesModifierAddress,
      data: rolesInterface.encodeFunctionData("setDefaultRole", [
        ownerAddress,
        roleKey,
      ]),
      value: BigInt(0),
      operation: 0,
    });

    // c. role scope + allowFunction + scopeFunction calls from the planner
    for (const call of encodedPermissionCalls) {
      multiSendCalls.push({
        to: call.to,
        data: call.data,
        value: BigInt(0),
        operation: 0,
      });
    }

    // d. per-(protocol, token) allowances
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const allowanceRowsInput: Array<{
      protocolSlug: string;
      allowanceKey: `0x${string}`;
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      maxRefillWei: string;
      refillWei: string;
      periodSeconds: number;
    }> = [];
    for (const a of tokenAllowances) {
      const normalizedToken = normalizeAddressForStorage(a.tokenAddress);
      const allowanceKey = tokenAllowanceKey(
        roleKey,
        a.protocolSlug,
        normalizedToken
      ) as `0x${string}`;
      const { symbol, decimals } = resolveTokenMetadata(
        chainId,
        normalizedToken,
        a.tokenSymbol,
        a.tokenDecimals
      );
      const maxRefill = BigInt(a.maxRefillWei);
      const refill = BigInt(a.refillWei);
      multiSendCalls.push({
        to: rolesModifierAddress,
        data: buildSetAllowanceCalldata({
          allowanceKey,
          balance: maxRefill,
          maxRefill,
          refill,
          period: BigInt(a.periodSeconds),
          timestamp: nowSec,
        }),
        value: BigInt(0),
        operation: 0,
      });
      allowanceRowsInput.push({
        protocolSlug: a.protocolSlug,
        allowanceKey,
        tokenAddress: normalizedToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        maxRefillWei: a.maxRefillWei,
        refillWei: a.refillWei,
        periodSeconds: a.periodSeconds,
      });
    }

    const multiSendCalldata = buildMultiSendCalldata(multiSendCalls);
    const outerCalldata = buildExecTransactionCalldata({
      to: multiSendAddress,
      data: multiSendCalldata,
      value: BigInt(0),
      operation: 1,
      ownerAddress,
    });

    const configResult = await withNonceSession(
      context,
      ownerAddress,
      (session) =>
        executeTransaction(
          context,
          ownerAddress,
          () => ({
            to: safeAddress,
            data: outerCalldata,
            value: BigInt(0),
            chainId,
          }),
          session
        )
    );

    if (!(configResult.success && configResult.receipt)) {
      throw new Error(configResult.error ?? "Role configuration tx reverted");
    }

    // Persist the caches
    const [roleRow] = await db
      .insert(safeRoles)
      .values({
        safeWalletId: safe.id,
        roleType: ROLE_TYPE_AUTOMATION,
        roleKey,
        rolesModifierAddress: normalizeAddressForStorage(rolesModifierAddress),
        delegateAddress: ownerAddress,
        installedTxHash: deployResult.txHash ?? configResult.txHash ?? null,
        lastReconciledAt: new Date(),
        status: "active",
      })
      .returning();

    // Only persist protocols the orchestrator actually applied on-chain.
    // Skipped ones (template pending or defi-kit rejected the token set) are
    // surfaced back to the UI via the `skippedProtocols` field on the
    // response so the admin can retry when templates ship.
    const protocolRows: SafeRoleProtocol[] = [];
    for (const slug of appliedProtocols) {
      const catalog = PROTOCOL_CATALOG[slug as keyof typeof PROTOCOL_CATALOG];
      if (!catalog) {
        continue;
      }
      const [row] = await db
        .insert(safeRoleProtocols)
        .values({
          roleId: roleRow.id,
          protocolSlug: slug,
          templateSlug: catalog.templateSlug,
          allowedTokenSymbols,
          targetAddresses: [],
          allowedSelectors: [],
          status: "allowed",
          lastAppliedTxHash: configResult.txHash ?? null,
        })
        .returning();
      protocolRows.push(row);
    }

    const allowanceRows: SafeRoleAllowance[] = [];
    for (const a of allowanceRowsInput) {
      const [row] = await db
        .insert(safeRoleAllowances)
        .values({
          roleId: roleRow.id,
          protocolSlug: a.protocolSlug,
          allowanceKey: a.allowanceKey,
          tokenAddress: a.tokenAddress,
          tokenSymbol: a.tokenSymbol,
          tokenDecimals: a.tokenDecimals,
          maxRefillWei: a.maxRefillWei,
          refillWei: a.refillWei,
          periodSeconds: a.periodSeconds,
          lastChainBalanceWei: a.maxRefillWei,
          lastChainTimestamp: new Date(Number(nowSec) * 1000),
          lastReconciledAt: new Date(),
          lastAppliedTxHash: configResult.txHash ?? null,
        })
        .returning();
      allowanceRows.push(row);
    }

    return {
      success: true,
      role: roleRow,
      protocols: protocolRows,
      allowances: allowanceRows,
      applied: appliedProtocols,
      skipped: skippedProtocols,
      alreadyInstalled: false,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Zodiac Roles install failed for org=${organizationId} chain=${chainId}`,
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: chainId.toString(),
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Per-token allowance CRUD (delta-only on-chain tx)
// ---------------------------------------------------------------------------

/**
 * Set or update a single token allowance on an already-installed Role.
 * Emits exactly one on-chain tx: Safe.execTransaction → modifier.setAllowance.
 */
export async function setRoleTokenAllowance(
  input: SetAllowanceInput
): Promise<SetAllowanceResult> {
  const { organizationId, chainId } = input;

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return { success: false, error: "Safe not found for this chain" };
  }
  const role = await findRoleForSafe(safe.id);
  if (!role || role.status !== "active") {
    return {
      success: false,
      error: "Install Zodiac Roles before setting spending limits",
    };
  }

  if (!ethers.isAddress(input.tokenAddress)) {
    return {
      success: false,
      error: `Invalid token address: ${input.tokenAddress}`,
    };
  }
  const normalizedToken = normalizeAddressForStorage(input.tokenAddress);
  const { symbol, decimals } = resolveTokenMetadata(
    chainId,
    normalizedToken,
    input.tokenSymbol,
    input.tokenDecimals
  );

  if (!input.protocolSlug) {
    return {
      success: false,
      error: "protocolSlug is required to set a per-protocol allowance",
    };
  }

  const allowanceKey = tokenAllowanceKey(
    role.roleKey,
    input.protocolSlug,
    normalizedToken
  ) as `0x${string}`;
  const maxRefill = BigInt(input.maxRefillWei);
  const refill = BigInt(input.refillWei);
  if (maxRefill <= BigInt(0)) {
    return {
      success: false,
      error: "maxRefillWei must be greater than zero",
    };
  }
  if (refill > maxRefill) {
    return {
      success: false,
      error: "refillWei must not exceed maxRefillWei",
    };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  const context: TransactionContext = {
    organizationId,
    executionId: `safe-roles-allowance-set-${generateId()}`,
    chainId,
    rpcUrl,
    triggerType: "manual",
    rpcManager,
  };

  try {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const innerCalldata = buildSetAllowanceCalldata({
      allowanceKey,
      balance: maxRefill,
      maxRefill,
      refill,
      period: BigInt(input.periodSeconds),
      timestamp: nowSec,
    });
    const outerCalldata = buildExecTransactionCalldata({
      to: role.rolesModifierAddress,
      data: innerCalldata,
      value: BigInt(0),
      operation: 0,
      ownerAddress,
    });

    const result = await withNonceSession(context, ownerAddress, (session) =>
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
      )
    );

    if (!result.success) {
      throw new Error(result.error ?? "setAllowance tx reverted");
    }

    const [row] = await db
      .insert(safeRoleAllowances)
      .values({
        roleId: role.id,
        protocolSlug: input.protocolSlug,
        allowanceKey,
        tokenAddress: normalizedToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        maxRefillWei: input.maxRefillWei,
        refillWei: input.refillWei,
        periodSeconds: input.periodSeconds,
        lastChainBalanceWei: input.maxRefillWei,
        lastChainTimestamp: new Date(Number(nowSec) * 1000),
        lastReconciledAt: new Date(),
        lastAppliedTxHash: result.txHash ?? null,
      })
      .onConflictDoUpdate({
        target: [
          safeRoleAllowances.roleId,
          safeRoleAllowances.protocolSlug,
          safeRoleAllowances.tokenAddress,
        ],
        set: {
          allowanceKey,
          maxRefillWei: input.maxRefillWei,
          refillWei: input.refillWei,
          periodSeconds: input.periodSeconds,
          lastChainBalanceWei: input.maxRefillWei,
          lastChainTimestamp: new Date(Number(nowSec) * 1000),
          lastReconciledAt: new Date(),
          lastAppliedTxHash: result.txHash ?? null,
          lastUpdatedAt: new Date(),
          tokenSymbol: symbol,
          tokenDecimals: decimals,
        },
      })
      .returning();

    return { success: true, allowance: row };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Role setAllowance failed for org=${organizationId} token=${normalizedToken}`,
      error,
      {
        component: "safe-roles-orchestrator",
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

/**
 * Revoke a per-token allowance. Sets the on-chain allowance to zero with a
 * zero refill period (effectively disabling it) and deletes the DB row.
 */
export async function revokeRoleTokenAllowance(input: {
  organizationId: string;
  chainId: number;
  protocolSlug: string;
  tokenAddress: string;
}): Promise<
  | { success: true; deleted: SafeRoleAllowance }
  | { success: false; error: string }
> {
  const { organizationId, chainId, protocolSlug, tokenAddress } = input;
  if (!ethers.isAddress(tokenAddress)) {
    return { success: false, error: `Invalid token address: ${tokenAddress}` };
  }
  if (!protocolSlug) {
    return {
      success: false,
      error: "protocolSlug is required to revoke a per-protocol allowance",
    };
  }

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return { success: false, error: "Safe not found" };
  }
  const role = await findRoleForSafe(safe.id);
  if (!role || role.status !== "active") {
    return { success: false, error: "No active role for this Safe" };
  }

  const normalizedToken = normalizeAddressForStorage(tokenAddress);
  const allowanceKey = tokenAllowanceKey(
    role.roleKey,
    protocolSlug,
    normalizedToken
  ) as `0x${string}`;

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  const context: TransactionContext = {
    organizationId,
    executionId: `safe-roles-allowance-revoke-${generateId()}`,
    chainId,
    rpcUrl,
    triggerType: "manual",
    rpcManager,
  };

  try {
    const innerCalldata = buildSetAllowanceCalldata({
      allowanceKey,
      balance: BigInt(0),
      maxRefill: BigInt(0),
      refill: BigInt(0),
      period: BigInt(0),
      timestamp: BigInt(0),
    });
    const outerCalldata = buildExecTransactionCalldata({
      to: role.rolesModifierAddress,
      data: innerCalldata,
      value: BigInt(0),
      operation: 0,
      ownerAddress,
    });

    const result = await withNonceSession(context, ownerAddress, (session) =>
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
      )
    );
    if (!result.success) {
      throw new Error(result.error ?? "revoke tx reverted");
    }

    const [deleted] = await db
      .delete(safeRoleAllowances)
      .where(
        and(
          eq(safeRoleAllowances.roleId, role.id),
          eq(safeRoleAllowances.protocolSlug, protocolSlug),
          eq(safeRoleAllowances.tokenAddress, normalizedToken)
        )
      )
      .returning();

    if (!deleted) {
      return {
        success: false,
        error: "Allowance zeroed on-chain but DB row was already missing",
      };
    }
    return { success: true, deleted };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Safe] Role revokeAllowance failed",
      error,
      {
        component: "safe-roles-orchestrator",
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

// ---------------------------------------------------------------------------
// Read helpers (list state)
// ---------------------------------------------------------------------------

export async function getSafeRole(
  safeWalletId: string
): Promise<SafeRole | null> {
  return await findRoleForSafe(safeWalletId);
}

export async function listRoleProtocols(
  roleId: string
): Promise<SafeRoleProtocol[]> {
  return await db
    .select()
    .from(safeRoleProtocols)
    .where(eq(safeRoleProtocols.roleId, roleId));
}

export async function listRoleAllowances(
  roleId: string
): Promise<SafeRoleAllowance[]> {
  return await db
    .select()
    .from(safeRoleAllowances)
    .where(eq(safeRoleAllowances.roleId, roleId));
}
