import "server-only";

import {
  type SimulateResult,
  simulateContractCall,
  simulateNativeTransfer,
  simulateTokenTransfer,
} from "@/lib/execute/simulate";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import {
  parseWeb3Connection,
  resolveSignerForNode,
  SIGNER_MODE,
} from "@/lib/safe/signer-resolver";
import { hasTemplateVariables } from "@/lib/utils/template";

const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

const SUPPORTED_ACTION_TYPES = new Set([
  "web3/transfer-funds",
  "web3/transfer-token",
  "web3/write-contract",
]);

type SupportedActionType =
  | "web3/transfer-funds"
  | "web3/transfer-token"
  | "web3/write-contract";

export type WorkflowSimulationNode = {
  id: string;
  type?: string;
  data?: {
    label?: string;
    type?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  };
};

export type WorkflowSimulationIssue = {
  code: string;
  message: string;
  parameterPath: string;
  nodeId: string;
  fieldKey?: string;
};

export type WorkflowSimulationResult = {
  errors: WorkflowSimulationIssue[];
  warnings: WorkflowSimulationIssue[];
  simulatedNodeCount: number;
  skippedNodeCount: number;
};

type RunWorkflowSimulationInput = {
  organizationId: string;
  nodes: WorkflowSimulationNode[];
};

type NodeSimulationContext = {
  node: WorkflowSimulationNode;
  nodeIndex: number;
  organizationId: string;
  actionType: SupportedActionType;
  config: Record<string, unknown>;
};

type NodeSimulationOutcome =
  | { status: "simulated" }
  | { status: "skipped"; warning?: WorkflowSimulationIssue }
  | { status: "failed"; issue: WorkflowSimulationIssue };

const ACTION_DYNAMIC_FIELDS: Record<SupportedActionType, readonly string[]> = {
  "web3/transfer-funds": [
    "network",
    "amount",
    "recipientAddress",
    "web3Connection",
  ],
  "web3/transfer-token": [
    "network",
    "tokenConfig",
    "tokenAddress",
    "decimals",
    "amount",
    "recipientAddress",
    "web3Connection",
  ],
  "web3/write-contract": [
    "network",
    "contractAddress",
    "abi",
    "abiFunction",
    "functionArgs",
    "ethValue",
    "web3Connection",
  ],
};

const ACTION_DEFAULT_FIELD: Record<SupportedActionType, string> = {
  "web3/transfer-funds": "recipientAddress",
  "web3/transfer-token": "recipientAddress",
  "web3/write-contract": "abiFunction",
};

function isSupportedActionType(
  actionType: unknown
): actionType is SupportedActionType {
  return (
    typeof actionType === "string" && SUPPORTED_ACTION_TYPES.has(actionType)
  );
}

function issuePath(nodeIndex: number, fieldKey?: string): string {
  const base = `nodes[${nodeIndex}].data.config`;
  return fieldKey ? `${base}.${fieldKey}` : base;
}

function nodeLabel(
  node: WorkflowSimulationNode,
  actionType: SupportedActionType
): string {
  return node.data?.label?.trim() || actionType;
}

function makeIssue(
  context: NodeSimulationContext,
  input: {
    code: string;
    message: string;
    fieldKey?: string;
  }
): WorkflowSimulationIssue {
  return {
    code: input.code,
    message: input.message,
    parameterPath: issuePath(context.nodeIndex, input.fieldKey),
    nodeId: context.node.id,
    fieldKey: input.fieldKey,
  };
}

function containsTemplate(
  value: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (typeof value === "string") {
    return hasTemplateVariables(value);
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => containsTemplate(entry, seen));
  }

  return Object.values(value as Record<string, unknown>).some((entry) =>
    containsTemplate(entry, seen)
  );
}

function findDynamicField(
  actionType: SupportedActionType,
  config: Record<string, unknown>
): string | undefined {
  return ACTION_DYNAMIC_FIELDS[actionType].find((fieldKey) =>
    containsTemplate(config[fieldKey])
  );
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return "";
}

function optionalStringValue(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized.length > 0 ? normalized : undefined;
}

function jsonStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value);
}

function optionalJsonStringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return;
  }

  return jsonStringValue(value);
}

function optionalDecimals(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    return Number.parseInt(value, 10);
  }

  return;
}

async function resolveEoaEligibility(
  context: NodeSimulationContext,
  chainId: number
): Promise<
  | { eligible: true }
  | { eligible: false; warning: WorkflowSimulationIssue }
  | { eligible: false; error: WorkflowSimulationIssue }
> {
  const rawConnection = optionalStringValue(context.config.web3Connection);

  let parsedConnection: ReturnType<typeof parseWeb3Connection>;

  try {
    parsedConnection = parseWeb3Connection(rawConnection);
  } catch (error) {
    return {
      eligible: false,
      error: makeIssue(context, {
        code: "SIMULATION_INVALID_WEB3_CONNECTION",
        fieldKey: "web3Connection",
        message:
          error instanceof Error
            ? error.message
            : "The Web3 Connection configuration is invalid.",
      }),
    };
  }

  if (parsedConnection.kind === SIGNER_MODE.EOA) {
    return { eligible: true };
  }

  if (parsedConnection.kind === SIGNER_MODE.SAFE) {
    return {
      eligible: false,
      warning: makeIssue(context, {
        code: "SIMULATION_SAFE_SIGNER_UNSUPPORTED",
        fieldKey: "web3Connection",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} uses a Safe connection. The current read-only simulator cannot reproduce the Safe execution path authoritatively, so this step was not simulated.`,
      }),
    };
  }

  try {
    const signerMode = await resolveSignerForNode({
      organizationId: context.organizationId,
      chainId,
      web3Connection: rawConnection,
    });

    if (signerMode.kind === SIGNER_MODE.EOA) {
      return { eligible: true };
    }

    return {
      eligible: false,
      warning: makeIssue(context, {
        code: "SIMULATION_SAFE_SIGNER_UNSUPPORTED",
        fieldKey: "web3Connection",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} resolves to a Safe signer. The current read-only simulator cannot reproduce the Safe execution path authoritatively, so this step was not simulated.`,
      }),
    };
  } catch {
    return {
      eligible: false,
      warning: makeIssue(context, {
        code: "SIMULATION_SIGNER_UNAVAILABLE",
        fieldKey: "web3Connection",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} could not resolve its signer for simulation. You can still run the workflow.`,
      }),
    };
  }
}

function runSimulator(context: NodeSimulationContext): Promise<SimulateResult> {
  const { actionType, config, organizationId } = context;

  if (actionType === "web3/transfer-funds") {
    return simulateNativeTransfer({
      organizationId,
      network: stringValue(config.network),
      recipientAddress: stringValue(config.recipientAddress),
      amount: stringValue(config.amount),
    });
  }

  if (actionType === "web3/transfer-token") {
    return simulateTokenTransfer({
      organizationId,
      network: stringValue(config.network),
      tokenConfig: optionalJsonStringValue(config.tokenConfig),
      tokenAddress: optionalStringValue(config.tokenAddress),
      recipientAddress: stringValue(config.recipientAddress),
      amount: stringValue(config.amount),
      decimals: optionalDecimals(config.decimals),
    });
  }

  return simulateContractCall({
    organizationId,
    network: stringValue(config.network),
    contractAddress: stringValue(config.contractAddress),
    abi: jsonStringValue(config.abi),
    functionName: stringValue(config.abiFunction),
    functionArgs: optionalJsonStringValue(config.functionArgs),
    value: optionalStringValue(config.ethValue),
  });
}

async function simulateNode(
  context: NodeSimulationContext
): Promise<NodeSimulationOutcome> {
  const dynamicField = findDynamicField(context.actionType, context.config);

  if (dynamicField) {
    return {
      status: "skipped",
      warning: makeIssue(context, {
        code: "SIMULATION_DYNAMIC_INPUT",
        fieldKey: dynamicField,
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} uses a runtime template in ${dynamicField}, so it cannot be simulated before upstream steps run.`,
      }),
    };
  }

  const network = stringValue(context.config.network);

  let chainId: number;

  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return {
      status: "failed",
      issue: makeIssue(context, {
        code: "SIMULATION_INVALID_NETWORK",
        fieldKey: "network",
        message:
          error instanceof Error
            ? error.message
            : "The selected network is invalid.",
      }),
    };
  }

  if (isSolanaChain(chainId)) {
    return {
      status: "skipped",
      warning: makeIssue(context, {
        code: "SIMULATION_UNSUPPORTED_CHAIN",
        fieldKey: "network",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} uses Solana. Workflow Run preflight currently supports EVM writes only.`,
      }),
    };
  }

  const signerEligibility = await resolveEoaEligibility(context, chainId);

  if (!signerEligibility.eligible) {
    if ("error" in signerEligibility) {
      return { status: "failed", issue: signerEligibility.error };
    }

    return {
      status: "skipped",
      warning: signerEligibility.warning,
    };
  }

  let result: SimulateResult;

  try {
    result = await runSimulator(context);
  } catch {
    return {
      status: "skipped",
      warning: makeIssue(context, {
        code: "SIMULATION_UNAVAILABLE",
        fieldKey: ACTION_DEFAULT_FIELD[context.actionType],
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} could not be simulated because the simulation service was unavailable. You can still run the workflow.`,
      }),
    };
  }

  if (result.success) {
    return { status: "simulated" };
  }

  if (result.failureKind === "unavailable") {
    return {
      status: "skipped",
      warning: makeIssue(context, {
        code: "SIMULATION_UNAVAILABLE",
        fieldKey: ACTION_DEFAULT_FIELD[context.actionType],
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} could not be simulated: ${result.error}`,
      }),
    };
  }

  return {
    status: "failed",
    issue: makeIssue(context, {
      code:
        result.failureKind === "revert"
          ? "SIMULATION_WOULD_REVERT"
          : "SIMULATION_INVALID_TRANSACTION",
      fieldKey: ACTION_DEFAULT_FIELD[context.actionType],
      message:
        result.failureKind === "revert"
          ? `${nodeLabel(
              context.node,
              context.actionType
            )} would revert: ${result.error}`
          : `${nodeLabel(
              context.node,
              context.actionType
            )} has invalid transaction inputs: ${result.error}`,
    }),
  };
}

/**
 * Simulate eligible static EVM write nodes before an interactive workflow run.
 *
 * This function never signs, broadcasts, creates execution records, reserves
 * spending limits or performs billing operations.
 */
export async function runWorkflowSimulation({
  organizationId,
  nodes,
}: RunWorkflowSimulationInput): Promise<WorkflowSimulationResult> {
  const errors: WorkflowSimulationIssue[] = [];
  const warnings: WorkflowSimulationIssue[] = [];
  let simulatedNodeCount = 0;
  let skippedNodeCount = 0;

  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.data?.enabled === false) {
      continue;
    }

    if (node.type !== "action" && node.data?.type !== "action") {
      continue;
    }

    const config = node.data?.config;
    const actionType = config?.actionType;

    if (!(config && isSupportedActionType(actionType))) {
      continue;
    }

    const outcome = await simulateNode({
      node,
      nodeIndex,
      organizationId,
      actionType,
      config,
    });

    if (outcome.status === "simulated") {
      simulatedNodeCount += 1;
      continue;
    }

    if (outcome.status === "failed") {
      errors.push(outcome.issue);
      continue;
    }

    skippedNodeCount += 1;
    if (outcome.warning) {
      warnings.push(outcome.warning);
    }
  }

  return {
    errors,
    warnings,
    simulatedNodeCount,
    skippedNodeCount,
  };
}
