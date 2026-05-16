// Pure validator — no DB, no network, no MCP SDK imports. Safe to call
// from tests and from the API route. Web3 + ABI checks land in
// Plans 48-02 and 48-03 as additional exported functions.

import { findFirstWriteActionNode } from "@/lib/mcp/calldata";
import {
  findBareAtLiterals,
  isInputSchemaPresent,
} from "@/lib/mcp/listing-validators";
import {
  VALIDATION_ERROR_CODES,
  VALIDATION_WARNING_CODES,
  type ValidationErrorCode,
  type ValidationWarningCode,
} from "@/lib/mcp/validate-workflow-codes";

export type ValidationIssue = {
  code: ValidationErrorCode | ValidationWarningCode;
  message: string;
  parameterPath: string;
};

export type ValidationResult = {
  valid: boolean;
  nodeCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

// Minimal workflow shape the validator needs. Mirrors workflows table
// columns: nodes, edges (read from workflow.edges JSONB or derived from
// the editor doc), inputSchema, outputMapping, isListed, workflowType.
export type ValidatorWorkflow = {
  id: string;
  nodes: unknown[];
  edges: unknown[];
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  isListed: boolean;
  workflowType: "read" | "write";
};

export function validateWorkflow(workflow: ValidatorWorkflow): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // VALID-02 structural checks (in spec order)
  runEmptyNodesCheck(workflow, errors);
  const nodeIds = collectNodeIds(workflow.nodes);
  runEdgeRefCheck(workflow, nodeIds, errors);
  runTriggerConfigCheck(workflow, errors);
  runBareAtCheck(workflow, errors);

  // VALID-03 listing-eligibility (only when isListed)
  if (workflow.isListed) {
    runInputSchemaCheck(workflow, errors);
  }
  runOutputMappingCheck(workflow, nodeIds, errors);

  // VALID-04 write-action consistency
  runWriteActionCheck(workflow, errors, warnings);

  return {
    valid: errors.length === 0,
    nodeCount: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
    errors,
    warnings,
  };
}

// ---- private check helpers ----

function collectNodeIds(nodes: unknown): Set<string> {
  if (!Array.isArray(nodes)) {
    return new Set();
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (
      node !== null &&
      typeof node === "object" &&
      "id" in node &&
      typeof (node as { id: unknown }).id === "string"
    ) {
      ids.add((node as { id: string }).id);
    }
  }
  return ids;
}

function runEmptyNodesCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    errors.push({
      code: VALIDATION_ERROR_CODES.EMPTY_NODES_ARRAY,
      message: "Workflow has no nodes. Add at least one trigger node.",
      parameterPath: "nodes",
    });
  }
}

function runEdgeRefCheck(
  workflow: ValidatorWorkflow,
  nodeIds: Set<string>,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.edges)) {
    return;
  }
  for (const [idx, edge] of workflow.edges.entries()) {
    if (edge === null || typeof edge !== "object") {
      continue;
    }
    const e = edge as { source?: unknown; target?: unknown };
    if (typeof e.source === "string" && !nodeIds.has(e.source)) {
      errors.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_EDGE_REFERENCE,
        message: `Edge ${idx} source "${e.source}" references a nodeId that is not in nodes[]`,
        parameterPath: `edges[${idx}].source`,
      });
    }
    if (typeof e.target === "string" && !nodeIds.has(e.target)) {
      errors.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_EDGE_REFERENCE,
        message: `Edge ${idx} target "${e.target}" references a nodeId that is not in nodes[]`,
        parameterPath: `edges[${idx}].target`,
      });
    }
  }
}

function runTriggerConfigCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.nodes)) {
    return;
  }
  const hasTrigger = workflow.nodes.some(
    (node) =>
      node !== null &&
      typeof node === "object" &&
      "data" in node &&
      (node as { data?: { type?: unknown } }).data?.type === "trigger"
  );
  if (!hasTrigger) {
    errors.push({
      code: VALIDATION_ERROR_CODES.MISSING_TRIGGER_CONFIG,
      message:
        "Workflow has no trigger node (no node with data.type === 'trigger')",
      parameterPath: "nodes",
    });
  }
}

function runBareAtCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  const literals = findBareAtLiterals(workflow.nodes);
  for (const literal of literals) {
    errors.push({
      code: VALIDATION_ERROR_CODES.BARE_AT_LITERAL_IN_TEMPLATE,
      message: `Bare @ literal "${literal}" found outside a {{...}} wrapper — wrap it as {{${literal}:...}} or remove it`,
      parameterPath: "nodes",
    });
  }
}

function runInputSchemaCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  if (!isInputSchemaPresent(workflow.inputSchema)) {
    errors.push({
      code: VALIDATION_ERROR_CODES.MISSING_INPUT_SCHEMA_ON_LISTED,
      message:
        "Listed workflow has null inputSchema. Bazaar consumers cannot render or validate inputs without it. An empty {type: 'object'} is acceptable for zero-input workflows.",
      parameterPath: "inputSchema",
    });
  }
}

function runOutputMappingCheck(
  workflow: ValidatorWorkflow,
  nodeIds: Set<string>,
  errors: ValidationIssue[]
): void {
  const { outputMapping } = workflow;
  if (outputMapping === null || typeof outputMapping !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(outputMapping)) {
    // outputMapping shape (per existing listing flow): { outputKey: { nodeId, field } | nodeIdString }
    // Be defensive: extract any string-typed nodeId reference and verify it.
    const referencedNodeId = extractNodeIdReference(value);
    if (referencedNodeId !== null && !nodeIds.has(referencedNodeId)) {
      errors.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_OUTPUT_MAPPING_NODE,
        message: `outputMapping.${key} references nodeId "${referencedNodeId}" which is not present in nodes[]`,
        parameterPath: `outputMapping.${key}`,
      });
    }
  }
}

function extractNodeIdReference(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object" && "nodeId" in value) {
    const { nodeId } = value as { nodeId?: unknown };
    return typeof nodeId === "string" ? nodeId : null;
  }
  return null;
}

function runWriteActionCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  const writeNode = Array.isArray(workflow.nodes)
    ? findFirstWriteActionNode(workflow.nodes)
    : undefined;
  if (workflow.workflowType === "write" && writeNode === undefined) {
    errors.push({
      code: VALIDATION_ERROR_CODES.MISSING_WRITE_ACTION_FOR_WRITE_WORKFLOW,
      message:
        'workflowType is "write" but no node has a write actionType (web3 write-contract or protocol-write).',
      parameterPath: "workflowType",
    });
  }
  if (workflow.workflowType === "read" && writeNode !== undefined) {
    warnings.push({
      code: VALIDATION_WARNING_CODES.WRITE_ACTION_ON_READ_WORKFLOW,
      message:
        'workflowType is "read" but workflow contains a write-action node. Confirm this is intentional.',
      parameterPath: "workflowType",
    });
  }
}
