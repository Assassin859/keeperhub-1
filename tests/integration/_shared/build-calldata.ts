/**
 * Shared calldata builder for protocol on-chain integration tests.
 *
 * Every protocol's on-chain integration test does the same six steps to
 * turn a (protocol, action slug, sample inputs, chain) tuple into the
 * `{ to, data }` pair eth_call needs:
 *
 *   1. Find the action by slug.
 *   2. Resolve the contract and its address for the target chain.
 *   3. Map sampleInputs to rawArgs via input.name.
 *   4. reshapeArgsForAbi against the function's ABI (re-wraps flattened
 *      tuple components into the object ethers.js expects).
 *   5. Encode calldata via ethers.Interface.
 *   6. Return { to, data, action, contract } for the caller to assert on.
 *
 * `chainId` is required so the helper cannot silently pick a wrong
 * chain when a protocol is deployed on multiple. `toOverride` is
 * opt-in for contracts marked `userSpecifiedAddress` (e.g. a Uniswap
 * V3 pool whose address is computed per pair at runtime).
 *
 * Per-protocol assertion patterns stay in their own test files; this
 * module deliberately handles only the calldata-encoding half of the
 * test setup.
 */

import { ethers } from "ethers";
import {
  coerceArgsForAbi,
  type FunctionAbiEntry,
  reshapeArgsForAbi,
} from "@/lib/abi/struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";

type AbiEntry = FunctionAbiEntry & {
  type: string;
  name?: string;
};

export type Calldata = {
  to: string;
  data: string;
  action: ProtocolAction;
  contract: ProtocolContract;
};

export type BuildCalldataParams = {
  /** The protocol definition the action belongs to. */
  protocol: ProtocolDefinition;
  /** Slug of the action to encode, as declared on `protocol.actions[i].slug`. */
  actionSlug: string;
  /** Map of input name to stringly-typed value. Must not contain keys
   *  that the action does not declare; unknown keys throw. Missing
   *  declared keys fall back to `inp.default ?? ""`. */
  sampleInputs: Record<string, string>;
  /** Chain ID string as it appears in `protocol.contracts[key].addresses`.
   *  Required; mistakes here are silent bugs (wrong contract on wrong
   *  chain) so the helper does not default. */
  chainId: string;
  /** Override the resolved contract address. Use for contracts marked
   *  `userSpecifiedAddress` where the address is supplied per call rather
   *  than from the protocol definition. */
  toOverride?: string;
  /**
   * Run `coerceArgsForAbi` after `reshapeArgsForAbi`, matching the
   * production write path in `plugins/web3/steps/write-contract-core.ts`
   * (reshape -> coerce -> encode). Required for protocols whose sample
   * inputs include stringly-typed booleans (`"true"`, `"false"`), since
   * `ethers.encodeFunctionData` treats any non-empty string as truthy and
   * silently encodes `"false"` as `true` without coercion.
   *
   * Defaults to `true` so tests match the production encoding pipeline
   * by default. Pass `false` only to deliberately exercise the
   * pre-coerce shape (e.g. a regression test asserting the trap exists).
   */
  coerceArgs?: boolean;
};

export function buildCalldata(params: BuildCalldataParams): Calldata {
  const {
    protocol,
    actionSlug,
    sampleInputs,
    chainId,
    toOverride,
    coerceArgs,
  } = params;

  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    throw new Error(`Action ${actionSlug} not found`);
  }

  const declaredInputNames = new Set(action.inputs.map((i) => i.name));
  for (const key of Object.keys(sampleInputs)) {
    if (!declaredInputNames.has(key)) {
      const known =
        action.inputs.length === 0
          ? "(none)"
          : action.inputs.map((i) => i.name).join(", ");
      throw new Error(
        `Sample input '${key}' is not declared for action '${action.slug}'. Known inputs: ${known}`
      );
    }
  }

  const contract = protocol.contracts[action.contract];
  if (!contract.abi) {
    throw new Error(`Contract ${action.contract} has no ABI`);
  }

  const to = toOverride ?? contract.addresses[chainId];
  if (!to) {
    throw new Error(
      `No address for contract ${action.contract} on chain ${chainId} and no toOverride given`
    );
  }

  const rawArgs = action.inputs.map(
    (inp) => sampleInputs[inp.name] ?? inp.default ?? ""
  );

  const parsedAbi = JSON.parse(contract.abi) as AbiEntry[];
  const functionAbi = parsedAbi.find(
    (f) => f.type === "function" && f.name === action.function
  );
  if (!functionAbi) {
    throw new Error(
      `Function ${action.function} not found in ABI for contract ${action.contract}`
    );
  }
  const reshaped = reshapeArgsForAbi(rawArgs, functionAbi);
  const args =
    coerceArgs === false ? reshaped : coerceArgsForAbi(reshaped, functionAbi);
  const iface = new ethers.Interface(parsedAbi);
  const data = iface.encodeFunctionData(action.function, args);

  return { to, data, action, contract };
}
