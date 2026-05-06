/**
 * Zodiac Roles Modifier v2 contract address registry.
 *
 * Roles v2.0.0 uses deterministic deployment (Nick's method) so the singleton
 * and ModuleProxyFactory addresses are identical across all supported chains.
 * Per-chain overrides are supported via CHAIN_OVERRIDES for chains that have
 * a non-canonical deployment.
 *
 * Source: https://github.com/gnosisguild/zodiac-modifier-roles/blob/main/packages/deployments
 * and verified via Clawlett (https://github.com/Creator-Bid/Clawlett) contract
 * constants + on-chain inspection.
 */

import { ethers } from "ethers";

export const ZODIAC_ROLES_VERSION: string = "2.0.0";

export type ZodiacContractAddresses = {
  /** Roles Modifier v2 implementation singleton (master copy) */
  rolesSingleton: string;
  /** Zodiac ModuleProxyFactory used to deploy a per-Safe Roles proxy */
  moduleProxyFactory: string;
};

const CANONICAL_ADDRESSES: ZodiacContractAddresses = {
  rolesSingleton: "0x9646fDAD06d3e24444381f44362a3B0eB343D337",
  moduleProxyFactory: "0x000000000000aDdB49795b0f9bA5BC298cDda236",
} as const;

/**
 * Per-chain overrides for chains that do not use the canonical Zodiac
 * deployment. Populated empty for launch; every supported Safe chain
 * (Ethereum, Optimism, Base, Arbitrum + their Sepolia testnets) uses the
 * canonical addresses.
 */
const CHAIN_OVERRIDES: Record<number, Partial<ZodiacContractAddresses>> = {};

export function getZodiacContracts(chainId: number): ZodiacContractAddresses {
  const overrides = CHAIN_OVERRIDES[chainId] ?? {};
  return { ...CANONICAL_ADDRESSES, ...overrides };
}

export function getRolesSingletonAddress(chainId: number): string {
  return getZodiacContracts(chainId).rolesSingleton;
}

export function getModuleProxyFactoryAddress(chainId: number): string {
  return getZodiacContracts(chainId).moduleProxyFactory;
}

/**
 * Role key helpers. Zodiac Roles uses `bytes32` identifiers for each role.
 * Our convention: keccak256("kh-role:" || orgId || ":" || chainId || ":automation").
 * Using a deterministic derivation means the role key is reproducible if we
 * ever need to re-derive it (e.g. to query on-chain state).
 */
export function orgAutomationRoleKey(
  organizationId: string,
  chainId: number
): string {
  const encoded = ethers.solidityPacked(
    ["string", "string", "string", "uint256", "string"],
    ["kh-role:", organizationId, ":", BigInt(chainId), ":automation"]
  );
  return ethers.keccak256(encoded);
}

/**
 * Allowance key helpers. Zodiac allowances are keyed by `bytes32`. We derive
 * per-(role, protocol, token) allowance keys so each protocol owns its own
 * spending bucket. Two protocols touching the same token (e.g. Aave V3 and
 * CoW both holding USDC) get independent caps that the admin can configure
 * separately on the wizard's per-protocol cards.
 *
 * The protocol slug is hashed into a `bytes32` via `ethers.id` so it
 * abi-packs cleanly alongside the existing `roleKey` + `address` operands.
 */
export function tokenAllowanceKey(
  roleKey: string,
  protocolSlug: string,
  tokenAddress: string
): string {
  const protocolDigest = ethers.id(protocolSlug);
  const encoded = ethers.solidityPacked(
    ["bytes32", "bytes32", "address"],
    [roleKey, protocolDigest, ethers.getAddress(tokenAddress)]
  );
  return ethers.keccak256(encoded);
}

/**
 * Direct-rule allowance key. Direct rules differ from protocol presets in
 * that two rules can target the same `(roleKey, "direct", token)` triple
 * but represent independent buckets — e.g. an `erc20-approve` to spender A
 * and an `erc20-transfer` to recipient B should not share a weekly cap.
 *
 * Including `kind` and `counterparty` in the digest gives each direct rule
 * its own on-chain allowance bucket so the wizard's per-rule cap matches
 * what the modifier actually enforces.
 */
export function directRuleAllowanceKey(
  roleKey: string,
  kind: string,
  counterparty: string,
  tokenAddress: string
): string {
  const ruleDigest = ethers.id(`direct:${kind}:${counterparty.toLowerCase()}`);
  const encoded = ethers.solidityPacked(
    ["bytes32", "bytes32", "address"],
    [roleKey, ruleDigest, ethers.getAddress(tokenAddress)]
  );
  return ethers.keccak256(encoded);
}
