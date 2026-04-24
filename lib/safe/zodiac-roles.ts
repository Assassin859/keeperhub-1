/**
 * Pure calldata helpers for Zodiac Roles Modifier v2.
 *
 * Everything here is stateless: no DB, no network, no signer. Orchestrators
 * pass the returned bytes into the transaction manager (wrapped in
 * safe.execTransaction for owner-signed ops or submitted directly as
 * execTransactionWithRole for the automation EOA).
 *
 * We import `rolesAbi` from zodiac-roles-sdk so we don't have to maintain a
 * second copy; ethers.Interface does the actual encoding.
 */

import { ethers } from "ethers";
// biome-ignore lint/style/useImportType: rolesAbi is a runtime value, not a type
import { rolesAbi } from "zodiac-roles-sdk";

/**
 * Zodiac ExecutionOptions — maps to the on-chain enum. `Both` = allow both
 * Call and DelegateCall; `Send` = Call-only; `DelegateCall` = delegate only;
 * `None` = no execution (shouldn't normally be used for writes).
 */
export const ExecutionOptions = {
  None: 0,
  Send: 1,
  DelegateCall: 2,
  Both: 3,
} as const;

export type ExecutionOptionsValue =
  (typeof ExecutionOptions)[keyof typeof ExecutionOptions];

/**
 * Operation for execTransactionWithRole. Mirrors the Safe Operation enum.
 */
export const SafeOperation = {
  Call: 0,
  DelegateCall: 1,
} as const;

export type SafeOperationValue =
  (typeof SafeOperation)[keyof typeof SafeOperation];

const rolesInterface = new ethers.Interface(rolesAbi);

/**
 * Module ProxyFactory ABI — we only need `deployModule` and its event.
 */
export const MODULE_PROXY_FACTORY_ABI = [
  "function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)",
] as const;

const moduleProxyFactoryInterface = new ethers.Interface(
  MODULE_PROXY_FACTORY_ABI
);

/**
 * Zodiac Roles Modifier setup signature. Called once against the freshly
 * deployed proxy to initialise the modifier with its owner / avatar / target.
 * For our deployment owner = avatar = target = Safe address.
 */
const ROLES_SETUP_ABI = ["function setUp(bytes initParams)"] as const;

const rolesSetupInterface = new ethers.Interface(ROLES_SETUP_ABI);

/**
 * MultiSend ABI — we wrap multiple owner-signed calls into a single Safe
 * transaction when the install/diff touches many module methods at once.
 */
export const MULTISEND_ABI = [
  "function multiSend(bytes transactions)",
] as const;

const multisendInterface = new ethers.Interface(MULTISEND_ABI);

// ---------------------------------------------------------------------------
// Roles Modifier calldata
// ---------------------------------------------------------------------------

export function buildAssignRoleCalldata(options: {
  delegate: string;
  roleKey: string;
}): string {
  return rolesInterface.encodeFunctionData("assignRoles", [
    options.delegate,
    [options.roleKey],
    [true],
  ]);
}

export function buildUnassignRoleCalldata(options: {
  delegate: string;
  roleKey: string;
}): string {
  return rolesInterface.encodeFunctionData("assignRoles", [
    options.delegate,
    [options.roleKey],
    [false],
  ]);
}

export function buildSetDefaultRoleCalldata(options: {
  delegate: string;
  roleKey: string;
}): string {
  return rolesInterface.encodeFunctionData("setDefaultRole", [
    options.delegate,
    options.roleKey,
  ]);
}

export function buildScopeTargetCalldata(options: {
  roleKey: string;
  target: string;
}): string {
  return rolesInterface.encodeFunctionData("scopeTarget", [
    options.roleKey,
    options.target,
  ]);
}

export function buildRevokeTargetCalldata(options: {
  roleKey: string;
  target: string;
}): string {
  return rolesInterface.encodeFunctionData("revokeTarget", [
    options.roleKey,
    options.target,
  ]);
}

export function buildAllowFunctionCalldata(options: {
  roleKey: string;
  target: string;
  selector: string;
  executionOptions?: ExecutionOptionsValue;
}): string {
  return rolesInterface.encodeFunctionData("allowFunction", [
    options.roleKey,
    options.target,
    options.selector,
    options.executionOptions ?? ExecutionOptions.Send,
  ]);
}

/**
 * Condition-flat tuple used by `scopeFunction`. Matches the on-chain struct:
 *   struct ConditionFlat { uint8 parent; Operator operator; ParameterType paramType; bytes compValue; }
 * Encoded as [parent, operator, paramType, compValue] tuples.
 */
export type ConditionFlat = {
  parent: number;
  operator: number;
  paramType: number;
  compValue: string;
};

export function buildScopeFunctionCalldata(options: {
  roleKey: string;
  target: string;
  selector: string;
  conditions: ConditionFlat[];
  executionOptions?: ExecutionOptionsValue;
}): string {
  return rolesInterface.encodeFunctionData("scopeFunction", [
    options.roleKey,
    options.target,
    options.selector,
    options.conditions.map((c) => [
      c.parent,
      c.operator,
      c.paramType,
      c.compValue,
    ]),
    options.executionOptions ?? ExecutionOptions.Send,
  ]);
}

/**
 * Set or update an allowance entry. Zodiac Roles keeps a per-allowanceKey
 * bucket with balance / maxRefill / refill / period / timestamp. Spend is
 * decremented automatically by the modifier when a call wrapped by this
 * allowance executes.
 */
export function buildSetAllowanceCalldata(options: {
  allowanceKey: string;
  balance: bigint;
  maxRefill: bigint;
  refill: bigint;
  period: bigint;
  timestamp: bigint;
}): string {
  const MAX_UINT128 = BigInt(2) ** BigInt(128) - BigInt(1);
  const MAX_UINT64 = BigInt(2) ** BigInt(64) - BigInt(1);
  if (options.balance > MAX_UINT128) {
    throw new Error("balance must fit in uint128");
  }
  if (options.maxRefill > MAX_UINT128) {
    throw new Error("maxRefill must fit in uint128");
  }
  if (options.refill > MAX_UINT128) {
    throw new Error("refill must fit in uint128");
  }
  if (options.period > MAX_UINT64) {
    throw new Error("period must fit in uint64");
  }
  if (options.timestamp > MAX_UINT64) {
    throw new Error("timestamp must fit in uint64");
  }
  return rolesInterface.encodeFunctionData("setAllowance", [
    options.allowanceKey,
    options.balance,
    options.maxRefill,
    options.refill,
    options.period,
    options.timestamp,
  ]);
}

/**
 * The primary execution primitive for automation. Called by the delegate EOA
 * (our Turnkey wallet) to route a transaction through the Safe subject to
 * the role's permissions.
 */
export function buildExecTransactionWithRoleCalldata(options: {
  to: string;
  value: bigint;
  data: string;
  operation?: SafeOperationValue;
  roleKey: string;
  shouldRevert?: boolean;
}): string {
  return rolesInterface.encodeFunctionData("execTransactionWithRole", [
    options.to,
    options.value,
    options.data,
    options.operation ?? SafeOperation.Call,
    options.roleKey,
    options.shouldRevert ?? true,
  ]);
}

// ---------------------------------------------------------------------------
// Deploy + setup via ModuleProxyFactory
// ---------------------------------------------------------------------------

/**
 * Encode the `setUp(initParams)` call used as the initializer bytes when
 * deploying a Roles modifier proxy. The modifier expects
 *   abi.encode(address owner, address avatar, address target)
 * where owner = who can change roles, avatar = the Safe whose storage the
 * modifier reads, target = the Safe the modifier calls back into.
 *
 * For our single-owner threshold-1 Safe all three are the Safe itself;
 * the Safe signs any role mutation through `execTransaction`.
 */
export function buildRolesSetUpCalldata(options: {
  owner: string;
  avatar: string;
  target: string;
}): string {
  const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [options.owner, options.avatar, options.target]
  );
  return rolesSetupInterface.encodeFunctionData("setUp", [initParams]);
}

export function buildDeployRolesCalldata(options: {
  rolesSingleton: string;
  initializer: string;
  saltNonce: bigint;
}): string {
  return moduleProxyFactoryInterface.encodeFunctionData("deployModule", [
    options.rolesSingleton,
    options.initializer,
    options.saltNonce,
  ]);
}

/**
 * Parse the `ModuleProxyCreation(proxy, masterCopy)` event to recover the
 * freshly-deployed Roles modifier proxy address from a tx receipt.
 */
export function parseModuleProxyCreationEvent(
  receipt: ethers.TransactionReceipt,
  factoryAddress: string
): string {
  const factoryLower = factoryAddress.toLowerCase();
  const topic = moduleProxyFactoryInterface.getEvent(
    "ModuleProxyCreation"
  )?.topicHash;
  if (!topic) {
    throw new Error("ModuleProxyCreation topic missing from ABI");
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factoryLower) {
      continue;
    }
    if (log.topics[0] !== topic) {
      continue;
    }
    const parsed = moduleProxyFactoryInterface.parseLog({
      topics: Array.from(log.topics),
      data: log.data,
    });
    if (!parsed) {
      continue;
    }
    return ethers.getAddress(parsed.args.proxy as string);
  }
  throw new Error(
    "ModuleProxyCreation event not found in transaction receipt logs"
  );
}

// ---------------------------------------------------------------------------
// MultiSend batching
// ---------------------------------------------------------------------------

export type MultiSendCall = {
  to: string;
  value?: bigint;
  data: string;
  /** 0 = Call, 1 = DelegateCall */
  operation?: 0 | 1;
};

/**
 * Pack a list of calls into the `multiSend(bytes)` format. Each call is:
 *   operation (1 byte) || to (20 bytes) || value (32 bytes) || dataLen (32 bytes) || data
 */
export function packMultiSendCalls(calls: MultiSendCall[]): string {
  const packed = calls
    .map((call) => {
      const to = ethers.getAddress(call.to).slice(2).toLowerCase();
      const dataHex = call.data.startsWith("0x")
        ? call.data.slice(2)
        : call.data;
      const dataBytes = dataHex.length / 2;
      const operation = (call.operation ?? 0).toString(16).padStart(2, "0");
      const valueHex = (call.value ?? BigInt(0)).toString(16).padStart(64, "0");
      const lenHex = dataBytes.toString(16).padStart(64, "0");
      return `${operation}${to}${valueHex}${lenHex}${dataHex}`;
    })
    .join("");
  return `0x${packed}`;
}

export function buildMultiSendCalldata(calls: MultiSendCall[]): string {
  return multisendInterface.encodeFunctionData("multiSend", [
    packMultiSendCalls(calls),
  ]);
}
