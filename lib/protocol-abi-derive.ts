/**
 * ABI-Driven Protocol Action Derivation
 *
 * Parses a reduced ABI (the subset of functions to expose) and generates
 * ProtocolAction[] with slugs, labels, types, inputs, and outputs inferred
 * from Solidity types. Overrides provide the editorial layer on top.
 */

import type {
  ProtocolAction,
  ProtocolActionInput,
  ProtocolActionInputComponent,
  ProtocolActionOutput,
} from "@/lib/protocol-registry";

// -- Override types ----------------------------------------------------------

export type AbiInputOverride = {
  name?: string;
  label?: string;
  helpTip?: string;
  docUrl?: string;
  default?: string;
  hidden?: boolean;
  required?: boolean;
  advanced?: boolean;
  decimals?: boolean | number;
  fieldType?: string;
};

export type AbiOutputOverride = {
  name?: string;
  label?: string;
  decimals?: number;
};

export type AbiFunctionOverride = {
  slug?: string;
  label?: string;
  description?: string;
  inputs?: Record<string, AbiInputOverride>;
  outputs?: Record<string, AbiOutputOverride>;
};

// -- ABI JSON types (subset of ethers ABI format) ----------------------------

type AbiParam = {
  name: string;
  type: string;
  components?: AbiParam[];
  indexed?: boolean;
};

type AbiFunctionEntry = {
  type: "function";
  name: string;
  stateMutability: "view" | "pure" | "nonpayable" | "payable";
  inputs: AbiParam[];
  outputs: AbiParam[];
};

type AbiEntry = AbiFunctionEntry | { type: string; [key: string]: unknown };

// -- Helpers -----------------------------------------------------------------

const UPPERCASE_BOUNDARY = /([a-z0-9])([A-Z])/g;
const CONSECUTIVE_UPPERCASE = /([A-Z]+)([A-Z][a-z])/g;

export function camelToKebab(s: string): string {
  return s
    .replace(UPPERCASE_BOUNDARY, "$1-$2")
    .replace(CONSECUTIVE_UPPERCASE, "$1-$2")
    .toLowerCase();
}

export function camelToTitle(s: string): string {
  const spaced = s
    .replace(UPPERCASE_BOUNDARY, "$1 $2")
    .replace(CONSECUTIVE_UPPERCASE, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isReadOnly(stateMutability: string): boolean {
  return stateMutability === "view" || stateMutability === "pure";
}

function defaultInputName(index: number): string {
  return `arg${index}`;
}

function defaultOutputName(index: number, total: number): string {
  return total === 1 ? "result" : `result${index}`;
}

// -- Derivation --------------------------------------------------------------

function toInputComponents(
  params: AbiParam[] | undefined
): ProtocolActionInputComponent[] | undefined {
  if (!params || params.length === 0) {
    return undefined;
  }
  return params.map((p) => ({
    name: p.name,
    type: p.type,
    ...(p.components ? { components: toInputComponents(p.components) } : {}),
  }));
}

function isFlattenableTuple(param: AbiParam): boolean {
  return (
    param.type === "tuple" &&
    param.components !== undefined &&
    param.components.length > 0
  );
}

function deriveInput(
  param: AbiParam,
  index: number,
  override: AbiInputOverride | undefined
): ProtocolActionInput | null {
  if (override?.hidden) {
    return null;
  }

  const rawName = param.name || defaultInputName(index);
  const name = override?.name ?? rawName;
  const label = override?.label ?? camelToTitle(rawName);

  const input: ProtocolActionInput = {
    name,
    type: override?.fieldType ?? param.type,
    label,
  };

  if (override?.default !== undefined) {
    input.default = override.default;
  }
  if (override?.required !== undefined) {
    input.required = override.required;
  }
  if (override?.advanced) {
    input.advanced = true;
  }
  if (override?.docUrl !== undefined) {
    input.docUrl = override.docUrl;
  }
  if (override?.helpTip !== undefined) {
    input.helpTip = override.helpTip;
  }
  if (override?.decimals !== undefined) {
    input.decimals = override.decimals;
  }

  const components = toInputComponents(param.components);
  if (components) {
    input.components = components;
  }

  return input;
}

function deriveTupleInputs(
  param: AbiParam,
  overrides: Record<string, AbiInputOverride> | undefined
): ProtocolActionInput[] {
  const inputs: ProtocolActionInput[] = [];
  const components = param.components ?? [];
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    const compOverride = overrides?.[comp.name || defaultInputName(i)];
    const derived = deriveInput(comp, i, compOverride);
    if (derived) {
      inputs.push(derived);
    }
  }
  return inputs;
}

function deriveOutput(
  param: AbiParam,
  index: number,
  total: number,
  override: AbiOutputOverride | undefined
): ProtocolActionOutput {
  const rawName = param.name || defaultOutputName(index, total);
  const name = override?.name ?? rawName;
  const label = override?.label ?? camelToTitle(rawName);

  const output: ProtocolActionOutput = {
    name,
    type: param.type,
    label,
  };

  if (override?.decimals !== undefined) {
    output.decimals = override.decimals;
  }

  return output;
}

function deriveAction(
  contractKey: string,
  fn: AbiFunctionEntry,
  override: AbiFunctionOverride | undefined
): ProtocolAction {
  const slug = override?.slug ?? camelToKebab(fn.name);
  const label = override?.label ?? camelToTitle(fn.name);
  const description =
    override?.description ?? `Call ${fn.name} on the contract`;
  const actionType = isReadOnly(fn.stateMutability) ? "read" : "write";
  const payable = fn.stateMutability === "payable";

  const inputs: ProtocolActionInput[] = [];
  for (let i = 0; i < fn.inputs.length; i++) {
    const param = fn.inputs[i];
    const paramKey = param.name || defaultInputName(i);

    if (isFlattenableTuple(param)) {
      const tupleInputs = deriveTupleInputs(param, override?.inputs);
      for (const inp of tupleInputs) {
        inputs.push(inp);
      }
    } else {
      const inputOverride = override?.inputs?.[paramKey];
      const derived = deriveInput(param, i, inputOverride);
      if (derived) {
        inputs.push(derived);
      }
    }
  }

  const outputs: ProtocolActionOutput[] = [];
  if (fn.outputs.length > 0) {
    for (let i = 0; i < fn.outputs.length; i++) {
      const param = fn.outputs[i];
      const paramKey = param.name || defaultOutputName(i, fn.outputs.length);
      const outputOverride = override?.outputs?.[paramKey];
      outputs.push(deriveOutput(param, i, fn.outputs.length, outputOverride));
    }
  }

  const action: ProtocolAction = {
    slug,
    label,
    description,
    type: actionType,
    contract: contractKey,
    function: fn.name,
    inputs,
  };

  if (outputs.length > 0) {
    action.outputs = outputs;
  }

  if (payable) {
    action.payable = true;
  }

  return action;
}

// -- Public API --------------------------------------------------------------

export type AbiDrivenContract = {
  label: string;
  abi: string;
  addresses: Record<string, string>;
  userSpecifiedAddress?: boolean;
  overrides?: Record<string, AbiFunctionOverride>;
};

export type AbiDrivenProtocolInput = {
  name: string;
  slug: string;
  description: string;
  website?: string;
  icon?: string;
  contracts: Record<string, AbiDrivenContract>;
};

export function deriveActionsFromAbi(
  contractKey: string,
  contract: AbiDrivenContract
): ProtocolAction[] {
  const parsed: AbiEntry[] = JSON.parse(contract.abi);
  const functions = parsed.filter(
    (entry): entry is AbiFunctionEntry => entry.type === "function"
  );

  const actions: ProtocolAction[] = [];
  for (const fn of functions) {
    const override = contract.overrides?.[fn.name];
    actions.push(deriveAction(contractKey, fn, override));
  }

  return actions;
}
