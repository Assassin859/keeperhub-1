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
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";

export type Calldata = {
  to: string;
  data: string;
  action: ProtocolAction;
  contract: ProtocolContract;
};

export type BuildCalldataOptions = {
  /**
   * Chain ID string as it appears in `protocol.contracts[key].addresses`.
   * Required; mistakes here are silent bugs (wrong contract on wrong
   * chain) so the helper does not default.
   */
  chainId: string;
  /**
   * Override the resolved contract address. Use for contracts marked
   * `userSpecifiedAddress` where the address is supplied per call rather
   * than from the protocol definition.
   */
  toOverride?: string;
  /**
   * Run `coerceArgsForAbi` after `reshapeArgsForAbi`, matching the
   * production write path in `plugins/web3/steps/write-contract-core.ts`
   * (reshape -> coerce -> encode). Required for protocols whose sample
   * inputs include stringly-typed booleans (`"true"`, `"false"`), since
   * `ethers.encodeFunctionData` treats any non-empty string as truthy and
   * silently encodes `"false"` as `true`. Default off to preserve the
   * pre-existing behavior of the 4 test suites converted in the same
   * PR as this helper; opt in per call site as needed.
   */
  coerceArgs?: boolean;
};

export function buildCalldata(
  protocol: ProtocolDefinition,
  actionSlug: string,
  sampleInputs: Record<string, string>,
  options: BuildCalldataOptions
): Calldata {
  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    throw new Error(`Action ${actionSlug} not found`);
  }

  const contract = protocol.contracts[action.contract];
  if (!contract.abi) {
    throw new Error(`Contract ${action.contract} has no ABI`);
  }

  const to = options.toOverride ?? contract.addresses[options.chainId];
  if (!to) {
    throw new Error(
      `No address for contract ${action.contract} on chain ${options.chainId}`
    );
  }

  const rawArgs = action.inputs.map(
    (inp) => sampleInputs[inp.name] ?? inp.default ?? ""
  );

  const abi = JSON.parse(contract.abi);
  const functionAbi = abi.find(
    (f: { name: string; type: string }) =>
      f.type === "function" && f.name === action.function
  );
  const reshaped = reshapeArgsForAbi(rawArgs, functionAbi);
  const args = options.coerceArgs
    ? coerceArgsForAbi(reshaped, functionAbi)
    : reshaped;
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(action.function, args);

  return { to, data, action, contract };
}
