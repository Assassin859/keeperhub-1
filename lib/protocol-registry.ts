import { solidityTypeToFieldType } from "@/lib/solidity-type-fields";
import type { IntegrationType } from "@/lib/types/integration";

import {
  createProtocolIconComponent,
  ProtocolIcon,
} from "@/plugins/protocol/icon";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
  IntegrationPlugin,
  PluginAction,
} from "@/plugins/registry";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export type ProtocolContract = {
  label: string;
  addresses: Record<string, string>;
  abi?: string;
  userSpecifiedAddress?: boolean;
};

export type ProtocolActionInputComponent = {
  name: string;
  type: string;
  components?: ProtocolActionInputComponent[];
};

export type ProtocolActionInput = {
  name: string;
  type: string;
  label: string;
  default?: string;
  required?: boolean;
  advanced?: boolean;
  decimals?: boolean | number;
  helpTip?: string;
  docUrl?: string;
  components?: ProtocolActionInputComponent[];
};

export type ProtocolActionOutput = {
  name: string;
  type: string;
  label: string;
  decimals?: number;
};

export type ProtocolEventInput = {
  name: string;
  type: string;
  indexed: boolean;
};

export type ProtocolEvent = {
  slug: string;
  label: string;
  description: string;
  eventName: string;
  contract: string;
  inputs: ProtocolEventInput[];
};

export type ProtocolAction = {
  slug: string;
  label: string;
  description: string;
  type: "read" | "write";
  contract: string;
  function: string;
  inputs: ProtocolActionInput[];
  outputs?: ProtocolActionOutput[];
  payable?: boolean;
};

export type ProtocolDefinition = {
  name: string;
  slug: string;
  description: string;
  website?: string;
  icon?: string;
  contracts: Record<string, ProtocolContract>;
  actions: ProtocolAction[];
  events?: ProtocolEvent[];
};

function validateSlug(slug: string, context: string): void {
  if (!KEBAB_CASE_REGEX.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}" in ${context}: must be kebab-case (lowercase letters, digits, hyphens; must start with a letter)`
    );
  }
}

function validateAddresses(contracts: Record<string, ProtocolContract>): void {
  for (const [contractKey, contract] of Object.entries(contracts)) {
    if (contract.userSpecifiedAddress) {
      continue;
    }
    for (const [chain, address] of Object.entries(contract.addresses)) {
      if (!HEX_ADDRESS_REGEX.test(address)) {
        throw new Error(
          `Invalid address "${address}" for contract "${contractKey}" on chain "${chain}": must be a 42-character hex string starting with 0x`
        );
      }
    }
  }
}

function validateContractRefs(
  actions: ProtocolAction[],
  contracts: Record<string, ProtocolContract>
): void {
  for (const action of actions) {
    if (!(action.contract in contracts)) {
      throw new Error(
        `Action "${action.slug}" references unknown contract "${action.contract}". Available contracts: ${Object.keys(contracts).join(", ")}`
      );
    }
  }
}

function validateEventContractRefs(
  events: ProtocolEvent[],
  contracts: Record<string, ProtocolContract>
): void {
  for (const event of events) {
    if (!(event.contract in contracts)) {
      throw new Error(
        `Event "${event.slug}" references unknown contract "${event.contract}". Available contracts: ${Object.keys(contracts).join(", ")}`
      );
    }
  }
}

export function buildEventAbiFragment(event: ProtocolEvent): string {
  const fragment = {
    type: "event" as const,
    name: event.eventName,
    inputs: event.inputs.map((inp) => ({
      name: inp.name,
      type: inp.type,
      indexed: inp.indexed,
    })),
  };
  return JSON.stringify([fragment]);
}

export function defineProtocol(def: ProtocolDefinition): ProtocolDefinition {
  if (Object.keys(def.contracts).length === 0) {
    throw new Error(`Protocol "${def.slug}" must define at least one contract`);
  }

  if (def.actions.length === 0) {
    throw new Error(`Protocol "${def.slug}" must define at least one action`);
  }

  validateSlug(def.slug, `protocol "${def.name}"`);

  for (const action of def.actions) {
    validateSlug(action.slug, `action of protocol "${def.slug}"`);
  }

  validateAddresses(def.contracts);
  validateContractRefs(def.actions, def.contracts);

  if (def.events && def.events.length > 0) {
    for (const event of def.events) {
      validateSlug(event.slug, `event of protocol "${def.slug}"`);
    }
    validateEventContractRefs(def.events, def.contracts);
  }

  return def;
}

// ABI-driven protocol definition
import {
  type AbiDrivenProtocolInput,
  deriveActionsFromAbi,
} from "@/lib/protocol-abi-derive";

export type {
  AbiDrivenContract,
  AbiDrivenProtocolInput,
  AbiFunctionOverride,
  AbiInputOverride,
  AbiOutputOverride,
} from "@/lib/protocol-abi-derive";

export function defineAbiProtocol(
  input: AbiDrivenProtocolInput
): ProtocolDefinition {
  const actions: ProtocolAction[] = [];
  const contracts: Record<string, ProtocolContract> = {};

  for (const [key, contract] of Object.entries(input.contracts)) {
    contracts[key] = {
      label: contract.label,
      abi: contract.abi,
      addresses: contract.addresses,
      ...(contract.userSpecifiedAddress ? { userSpecifiedAddress: true } : {}),
    };
    const derived = deriveActionsFromAbi(key, contract);
    for (const action of derived) {
      actions.push(action);
    }
  }

  return defineProtocol({
    name: input.name,
    slug: input.slug,
    description: input.description,
    website: input.website,
    icon: input.icon,
    contracts,
    actions,
  });
}

// Runtime protocol registry
const protocolRegistry = new Map<string, ProtocolDefinition>();

export function registerProtocol(def: ProtocolDefinition): void {
  defineProtocol(def);
  protocolRegistry.set(def.slug, def);
}

export function getProtocol(slug: string): ProtocolDefinition | undefined {
  return protocolRegistry.get(slug);
}

export function getRegisteredProtocols(): ProtocolDefinition[] {
  return Array.from(protocolRegistry.values());
}

function buildInputField(input: ProtocolActionInput): ActionConfigFieldBase {
  const labelWithType = `${input.label} (${input.type})`;
  const hasDefault = input.default !== undefined;
  const isRequired = input.required ?? !hasDefault;
  const hasTupleArrayComponents =
    input.type.endsWith("[]") &&
    input.components !== undefined &&
    input.components.length > 0;

  const tipFields = {
    ...(input.helpTip ? { helpTip: input.helpTip } : {}),
    ...(input.docUrl ? { docUrl: input.docUrl } : {}),
  };

  if (hasTupleArrayComponents) {
    return {
      key: input.name,
      label: labelWithType,
      type: "protocol-tuple-array",
      required: isRequired,
      solidityType: input.type,
      tupleComponents: input.components,
      ...tipFields,
    };
  }

  const fieldType = solidityTypeToFieldType(input.type);
  return {
    key: input.name,
    label: labelWithType,
    type: fieldType,
    required: isRequired,
    ...(hasDefault ? { defaultValue: input.default } : {}),
    ...(fieldType === "protocol-address" || input.type === "address"
      ? { isAddressField: true }
      : {}),
    ...tipFields,
    ...(fieldType === "template-input" ? {} : { solidityType: input.type }),
  };
}

function buildConfigFieldsFromAction(
  def: ProtocolDefinition,
  action: ProtocolAction
): ActionConfigField[] {
  const contract = def.contracts[action.contract];
  const fields: ActionConfigField[] = [
    {
      key: "network",
      label: "Network",
      type: "chain-select",
      chainTypeFilter: "evm",
      // KEEP-137: write actions show private mempool variants (e.g., Flashbots)
      ...(action.type === "write" ? { showPrivateVariants: true } : {}),
      required: true,
    },
  ];

  if (contract?.userSpecifiedAddress) {
    fields.push({
      key: "contractAddress",
      label: `${contract.label} Address`,
      type: "template-input",
      placeholder: "0x...",
      required: true,
      isAddressField: true,
    });
  }

  if (action.payable) {
    fields.push({
      key: "ethValue",
      label: "ETH Value",
      type: "protocol-eth-value",
      placeholder: "0.0",
      required: true,
    });
  }

  const advancedFields: ActionConfigFieldBase[] = [];

  for (const input of action.inputs) {
    const field = buildInputField(input);
    if (input.advanced) {
      advancedFields.push(field);
    } else {
      fields.push(field);
    }
  }

  if (action.type === "write") {
    advancedFields.push({
      key: "gasLimitMultiplier",
      label: "Gas Limit",
      type: "gas-limit-multiplier",
      networkField: "network",
      actionSlug: action.slug,
    });
  }

  if (advancedFields.length > 0) {
    fields.push({
      type: "group",
      label: "Advanced",
      defaultExpanded: false,
      fields: advancedFields,
    });
  }

  const metaValue = JSON.stringify({
    protocolSlug: def.slug,
    contractKey: action.contract,
    functionName: action.function,
    actionType: action.type,
  });

  fields.push({
    key: "_protocolMeta",
    label: "Protocol Metadata",
    type: "text",
    defaultValue: metaValue,
  });

  return fields;
}

function buildOutputFieldsFromAction(
  action: ProtocolAction
): Array<{ field: string; description: string }> {
  const outputs: Array<{ field: string; description: string }> = [];

  if (action.outputs) {
    for (const output of action.outputs) {
      outputs.push({ field: output.name, description: output.label });
    }
  }

  outputs.push({
    field: "success",
    description: "Whether the operation succeeded",
  });
  outputs.push({
    field: "error",
    description: "Error message if the operation failed",
  });

  if (action.type === "write") {
    outputs.push({ field: "transactionHash", description: "Transaction hash" });
    outputs.push({
      field: "transactionLink",
      description: "Explorer link to transaction",
    });
  }

  return outputs;
}

export function protocolActionToPluginAction(
  def: ProtocolDefinition,
  action: ProtocolAction
): PluginAction {
  return {
    slug: action.slug,
    label: `${def.name}: ${action.label}`,
    description: action.description,
    category: def.name,
    stepFunction:
      action.type === "read" ? "protocolReadStep" : "protocolWriteStep",
    stepImportPath: action.type === "read" ? "protocol-read" : "protocol-write",
    requiresCredentials: action.type === "write",
    ...(action.type === "write" ? { credentialIntegrationType: "web3" } : {}),
    configFields: buildConfigFieldsFromAction(def, action),
    outputFields: buildOutputFieldsFromAction(action),
  };
}

export function protocolToPlugin(def: ProtocolDefinition): IntegrationPlugin {
  return {
    type: def.slug as IntegrationType,
    label: def.name,
    description: def.description,
    icon: def.icon
      ? createProtocolIconComponent(def.icon, def.name)
      : ProtocolIcon,
    requiresCredentials: false,
    singleConnection: true,
    formFields: [],
    actions: def.actions.map((action) =>
      protocolActionToPluginAction(def, action)
    ),
  };
}
