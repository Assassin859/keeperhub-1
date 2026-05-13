import { ADDRESS_BOOK_SELECTION_KEY } from "@/lib/address-book-selection";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  findActionById,
} from "@/plugins/registry";

const SYSTEM_ACTION_TYPES = new Set([
  "Database Query",
  "HTTP Request",
  "Condition",
  "For Each",
  "Collect",
]);

const RESERVED_CONFIG_KEYS = new Set([
  "actionType",
  "integrationId",
  ADDRESS_BOOK_SELECTION_KEY,
  "usePrivateMempool",
  "strict",
]);

const TEMPLATE_VALUE_PATTERN = /\{\{[^}]+}}/;
const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const INTEGER_PATTERN = /^-?\d+$/;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

export type ActionConfigValidationIssueCode =
  | "UNKNOWN_ACTION_TYPE"
  | "UNKNOWN_FIELD"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FIELD_TYPE";

export type ActionConfigValidationIssue = {
  code: ActionConfigValidationIssueCode;
  path: string;
  message: string;
  actionType?: string;
  field?: string;
  expected?: string;
  received?: unknown;
};

export type ActionConfigValidationResult = {
  valid: boolean;
  issues: ActionConfigValidationIssue[];
};

type WorkflowNodeForValidation = {
  id?: string;
  type?: unknown;
  data?: {
    type?: unknown;
    config?: Record<string, unknown>;
  };
};

type FieldCheckResult =
  | { valid: true }
  | { valid: false; expected: string; received: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionNode(node: WorkflowNodeForValidation): boolean {
  return node.type === "action" || node.data?.type === "action";
}

function isMissingRequiredValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function flattenConfigFields(
  fields: ActionConfigField[]
): ActionConfigFieldBase[] {
  const flattened: ActionConfigFieldBase[] = [];

  for (const field of fields) {
    if (field.type === "group") {
      flattened.push(...flattenConfigFields(field.fields));
      continue;
    }
    flattened.push(field);
  }

  return flattened;
}

function valueContainsTemplate(value: unknown): boolean {
  return typeof value === "string" && TEMPLATE_VALUE_PATTERN.test(value);
}

function validateStringLike(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

function validateFieldValue(
  field: ActionConfigFieldBase,
  value: unknown
): FieldCheckResult {
  if (isMissingRequiredValue(value)) {
    return { valid: true };
  }

  switch (field.type) {
    case "number":
      return typeof value === "number" || DECIMAL_PATTERN.test(String(value))
        ? { valid: true }
        : { valid: false, expected: "number", received: value };
    case "select":
      if (!validateStringLike(value)) {
        return { valid: false, expected: "select option", received: value };
      }
      if (
        field.options &&
        field.options.length > 0 &&
        !field.options.some((option) => option.value === String(value))
      ) {
        return {
          valid: false,
          expected: field.options.map((option) => option.value).join(" | "),
          received: value,
        };
      }
      return { valid: true };
    case "chain-select":
      if (!validateStringLike(value)) {
        return { valid: false, expected: "chain id", received: value };
      }
      if (
        field.allowedChainIds &&
        field.allowedChainIds.length > 0 &&
        !field.allowedChainIds.includes(String(value))
      ) {
        return {
          valid: false,
          expected: field.allowedChainIds.join(" | "),
          received: value,
        };
      }
      return { valid: true };
    case "protocol-address":
      return typeof value === "string" &&
        !valueContainsTemplate(value) &&
        ETH_ADDRESS_PATTERN.test(value)
        ? { valid: true }
        : { valid: false, expected: "address", received: value };
    case "protocol-uint":
      return typeof value === "string" && UNSIGNED_INTEGER_PATTERN.test(value)
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "uint",
            received: value,
          };
    case "protocol-int":
      return typeof value === "string" && INTEGER_PATTERN.test(value)
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "int",
            received: value,
          };
    case "protocol-bool":
      return value === true ||
        value === false ||
        value === "true" ||
        value === "false"
        ? { valid: true }
        : { valid: false, expected: "boolean", received: value };
    case "protocol-bytes":
      return typeof value === "string" &&
        !valueContainsTemplate(value) &&
        HEX_BYTES_PATTERN.test(value)
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "bytes",
            received: value,
          };
    case "protocol-eth-value":
      return typeof value === "string" && DECIMAL_PATTERN.test(value)
        ? { valid: true }
        : { valid: false, expected: "decimal ETH amount", received: value };
    case "protocol-tuple-array":
      return Array.isArray(value)
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "tuple[]",
            received: value,
          };
    case "json-editor":
    case "schema-builder":
    case "abi-function-args":
    case "call-list-builder":
    case "args-list-builder":
      return isRecord(value) || Array.isArray(value)
        ? { valid: true }
        : { valid: false, expected: "object or array", received: value };
    default:
      if (field.isAddressField && valueContainsTemplate(value)) {
        return { valid: false, expected: "address", received: value };
      }
      return validateStringLike(value) || typeof value === "boolean"
        ? { valid: true }
        : { valid: false, expected: "string", received: value };
  }
}

export function validateWorkflowActionConfigs(
  nodes: WorkflowNodeForValidation[]
): ActionConfigValidationResult {
  const issues: ActionConfigValidationIssue[] = [];

  for (const [nodeIndex, node] of nodes.entries()) {
    if (!isActionNode(node)) {
      continue;
    }

    const config = node.data?.config;
    if (!isRecord(config)) {
      continue;
    }

    const actionType = config.actionType;
    if (typeof actionType !== "string" || actionType.trim() === "") {
      continue;
    }

    if (SYSTEM_ACTION_TYPES.has(actionType)) {
      continue;
    }

    const action = findActionById(actionType);
    if (!action) {
      issues.push({
        code: "UNKNOWN_ACTION_TYPE",
        path: `nodes[${nodeIndex}].data.config.actionType`,
        actionType,
        received: actionType,
        message: `Unknown action type "${actionType}".`,
      });
      continue;
    }

    const fields = flattenConfigFields(action.configFields);
    const fieldsByKey = new Map(fields.map((field) => [field.key, field]));

    for (const [key, value] of Object.entries(config)) {
      if (RESERVED_CONFIG_KEYS.has(key)) {
        continue;
      }
      if (!fieldsByKey.has(key)) {
        issues.push({
          code: "UNKNOWN_FIELD",
          path: `nodes[${nodeIndex}].data.config.${key}`,
          actionType,
          field: key,
          received: value,
          message: `Unknown field "${key}" for action "${actionType}".`,
        });
      }
    }

    for (const field of fields) {
      if (!evaluateShowWhen(field.showWhen, config)) {
        continue;
      }

      const value = config[field.key];
      if (field.required && isMissingRequiredValue(value)) {
        issues.push({
          code: "MISSING_REQUIRED_FIELD",
          path: `nodes[${nodeIndex}].data.config.${field.key}`,
          actionType,
          field: field.key,
          expected: field.label,
          message: `Missing required field "${field.key}" for action "${actionType}".`,
        });
        continue;
      }

      const fieldCheck = validateFieldValue(field, value);
      if (!fieldCheck.valid) {
        issues.push({
          code: "INVALID_FIELD_TYPE",
          path: `nodes[${nodeIndex}].data.config.${field.key}`,
          actionType,
          field: field.key,
          expected: fieldCheck.expected,
          received: fieldCheck.received,
          message: `Invalid value for field "${field.key}" on action "${actionType}".`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function formatActionConfigValidationResponse(
  validation: ActionConfigValidationResult
) {
  return {
    error: "INVALID_ACTION_CONFIG",
    message:
      "Workflow contains invalid action configuration. Fix the listed fields and save again.",
    invalidFields: validation.issues,
  };
}
